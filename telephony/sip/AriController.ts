import { EventEmitter } from 'events';

// Asterisk REST Interface client.
//
// Uses Node 22's built-in WebSocket and fetch, so telephony adds no npm
// dependency at all — worth having when the deploy target is a small VPS.
//
// What Asterisk does for us, and why that is the whole design
// -----------------------------------------------------------
// Asterisk owns SIP registration, RTP, NAT traversal, DTMF and codec
// negotiation with the trunk, and — critically — transcodes the trunk's G.711
// to `slin16`. That last part means the audio arriving at our AudioSocket is
// already 16 kHz linear PCM, which is exactly what Gemini Live wants, so the
// inbound path needs no conversion whatsoever.
//
// Writing a SIP stack and an RTP jitter buffer in Node instead would be weeks
// of work to arrive somewhere worse.

export interface AriOptions {
  /** e.g. http://127.0.0.1:8088 */
  baseUrl:  string;
  username: string;
  password: string;
  /** Stasis application name. Must match the dialplan's Stasis() argument. */
  app:      string;
  /** host:port Asterisk should dial back to for media — our AudioSocket server. */
  audioSocketAddress: string;
}

export interface IncomingCall {
  channelId: string;
  from?:     string;
  to?:       string;
}

interface AriChannelEvent {
  type:     string;
  channel?: {
    id:      string;
    name:    string;
    caller?: { number?: string };
    dialplan?: { exten?: string };
  };
}

export class AriController extends EventEmitter {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: AriOptions) { super(); }

  // ── REST ───────────────────────────────────────────────────────────────────

  private async rest(
    method: string, path: string, params: Record<string, string> = {},
  ): Promise<unknown> {
    const url = new URL(this.opts.baseUrl.replace(/\/$/, '') + '/ari' + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const auth = Buffer.from(`${this.opts.username}:${this.opts.password}`).toString('base64');
    const res  = await fetch(url, { method, headers: { Authorization: `Basic ${auth}` } });

    if (!res.ok) {
      throw new Error(`[ARI] ${method} ${path} → ${res.status} ${await res.text().catch(() => '')}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) as unknown : null;
  }

  answer(channelId: string): Promise<unknown> {
    return this.rest('POST', `/channels/${encodeURIComponent(channelId)}/answer`);
  }

  hangup(channelId: string): Promise<unknown> {
    return this.rest('DELETE', `/channels/${encodeURIComponent(channelId)}`)
      .catch(() => null);   // already gone is not an error worth propagating
  }

  /**
   * Create the media leg: Asterisk opens a TCP connection to our AudioSocket
   * server and streams this channel's audio over it.
   *
   * `format: slin16` is the single most important parameter in this file — it
   * is what makes Asterisk do the transcoding and hand us Gemini-ready audio.
   */
  async startExternalMedia(channelId: string, callUuid: string): Promise<string> {
    const media = await this.rest('POST', '/channels/externalMedia', {
      app:           this.opts.app,
      external_host: this.opts.audioSocketAddress,
      format:        'slin16',
      encapsulation: 'audiosocket',
      transport:     'tcp',
      direction:     'both',
      data:          callUuid,
    }) as { id?: string };

    const mediaId = media?.id;
    if (!mediaId) throw new Error('[ARI] externalMedia returned no channel id');

    // A mixing bridge joins the caller's channel to the media channel so audio
    // flows both ways between the trunk and us.
    const bridge = await this.rest('POST', '/bridges', { type: 'mixing' }) as { id?: string };
    if (!bridge?.id) throw new Error('[ARI] could not create a bridge');

    await this.rest('POST', `/bridges/${bridge.id}/addChannel`, {
      channel: `${channelId},${mediaId}`,
    });

    return bridge.id;
  }

  /** Bridge the caller to a human. Used by the transfer_to_human tool. */
  async transfer(channelId: string, toNumber: string, context = 'from-internal'): Promise<void> {
    await this.rest('POST', `/channels/${encodeURIComponent(channelId)}/redirect`, {
      endpoint: `Local/${toNumber}@${context}`,
    });
  }

  // ── Event stream ───────────────────────────────────────────────────────────

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;

    const url = new URL(
      this.opts.baseUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ari/events',
    );
    url.searchParams.set('app', this.opts.app);
    url.searchParams.set('subscribeAll', 'true');
    // ARI accepts credentials in the query string for the WebSocket; there is
    // no header to put them in. This is a loopback connection to Asterisk on
    // the same host, which is why that is acceptable — do not expose 8088.
    url.searchParams.set('api_key', `${this.opts.username}:${this.opts.password}`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      console.log(`[ARI] connected to ${this.opts.baseUrl} as app "${this.opts.app}"`);
      this.emit('ready');
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        this.onEvent(JSON.parse(String(ev.data)) as AriChannelEvent);
      } catch (err) {
        console.warn('[ARI] unparseable event:', (err as Error).message);
      }
    });

    ws.addEventListener('error', () => {
      // The close handler does the reconnecting; an error without a close is
      // not a thing WebSocket does.
    });

    ws.addEventListener('close', () => {
      this.ws = null;
      if (this.stopped) return;

      // Backoff with jitter. Asterisk restarting must not be met with a tight
      // reconnect loop from every app instance at once.
      const base  = Math.min(1000 * 2 ** this.reconnectAttempt, 30_000);
      const delay = base * (0.5 + Math.random() * 0.5);
      this.reconnectAttempt++;

      console.warn(`[ARI] disconnected — reconnecting in ${Math.round(delay)}ms`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private onEvent(event: AriChannelEvent): void {
    switch (event.type) {
      case 'StasisStart': {
        const ch = event.channel;
        if (!ch) return;

        // The external media channel enters Stasis too. Ignore it, or every
        // call would recurse into creating another media channel.
        if (ch.name?.startsWith('UnicastRTP') || ch.name?.startsWith('AudioSocket')) return;

        this.emit('call', {
          channelId: ch.id,
          from:      ch.caller?.number,
          to:        ch.dialplan?.exten,
        } satisfies IncomingCall);
        break;
      }

      case 'StasisEnd':
        if (event.channel) this.emit('hangup', event.channel.id);
        break;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
  }
}
