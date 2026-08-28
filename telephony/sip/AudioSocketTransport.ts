import net from 'net';
import { EventEmitter } from 'events';
import {
  FRAME, FrameParser, encodeFrame, formatUuid, chunkPcm, bytesPerFrame, FRAME_MS,
} from './audiosocket.js';
import type { CallTransport, CallMetadata } from './CallTransport.js';

// A TCP server speaking Asterisk's AudioSocket protocol.
//
// Asterisk connects OUT to us, one connection per call, when the dialplan
// creates an external media channel. So this listens; it never dials.
//
// The audio is 16 kHz signed linear in both directions because the external
// media channel is created as `slin16` — Asterisk does the G.711 transcoding
// that the trunk requires, which is the single biggest simplification in the
// whole design. See telephony/sip/README-asterisk.md for the dialplan.

const MAX_QUEUE_FRAMES = 250;   // 5 seconds at 20 ms — see enqueue()

export class AudioSocketCall extends EventEmitter implements CallTransport {
  readonly metadata: CallMetadata;

  private readonly parser = new FrameParser();
  private readonly queue: Buffer[] = [];
  private pacer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private audioCb: ((pcm: Buffer) => void) | null = null;
  private closeCb: ((reason: string) => void) | null = null;

  constructor(private readonly socket: net.Socket, metadata: CallMetadata) {
    super();
    this.metadata = metadata;

    socket.on('data',  (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err) => this.shutdown(`socket error: ${err.message}`));
    socket.on('close', () => this.shutdown('socket closed'));

    // Nagle would coalesce our 20 ms frames into bursts, which is exactly the
    // buffering the pacer exists to avoid.
    socket.setNoDelay(true);

    this.startPacer();
  }

  get queued(): number { return this.queue.length; }

  onAudio(cb: (pcm: Buffer) => void): void { this.audioCb = cb; }
  onClose(cb: (reason: string) => void): void { this.closeCb = cb; }

  private onData(chunk: Buffer): void {
    for (const frame of this.parser.push(chunk)) {
      switch (frame.type) {
        case FRAME.AUDIO:
          this.audioCb?.(frame.payload);
          break;

        case FRAME.UUID:
          // Asterisk's own id for the media session. Kept for correlating our
          // record with the provider's CDR.
          this.metadata.callRef = this.metadata.callRef || formatUuid(frame.payload);
          break;

        case FRAME.TERMINATE:
          this.shutdown('caller hung up');
          break;

        case FRAME.ERROR:
          this.shutdown(`asterisk error: ${frame.payload.toString('hex')}`);
          break;

        default:
          // Unknown frame types are skipped rather than fatal — the protocol
          // may gain types, and a call is worth more than strictness.
          console.warn(`[AUDIOSOCKET] ignoring unknown frame type 0x${frame.type.toString(16)}`);
      }
    }
  }

  write(pcm16k: Buffer): void {
    if (this.closed) return;
    for (const f of chunkPcm(pcm16k, 16000)) this.enqueue(f);
  }

  private enqueue(frame: Buffer): void {
    // A hard cap on the queue. If we are more than five seconds ahead of real
    // time, something upstream is generating faster than a phone call can
    // consume — and every queued frame is one that cannot be dropped on
    // barge-in. Shedding the oldest keeps the conversation responsive instead
    // of letting it drift further and further behind.
    if (this.queue.length >= MAX_QUEUE_FRAMES) {
      this.queue.shift();
      console.warn(`[AUDIOSOCKET] ${this.metadata.callRef}: output queue full, dropping oldest frame`);
    }
    this.queue.push(frame);
  }

  /**
   * Send one frame every 20 ms, silence when there is nothing to say.
   *
   * The continuous silence matters: Asterisk expects a steady stream on an
   * external media channel, and a gap is treated as the media having stopped.
   */
  private startPacer(): void {
    const silence = Buffer.alloc(bytesPerFrame(16000));
    this.pacer = setInterval(() => {
      if (this.closed) return;
      const frame = this.queue.shift() ?? silence;
      try {
        this.socket.write(encodeFrame(FRAME.AUDIO, frame));
      } catch (err) {
        this.shutdown(`write failed: ${(err as Error).message}`);
      }
    }, FRAME_MS);
  }

  flush(): void {
    // Barge-in. Everything queued is audio the caller has already decided they
    // do not want to hear.
    this.queue.length = 0;
  }

  hangup(): void {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(FRAME.TERMINATE));
    } catch { /* the socket may already be gone */ }
    this.shutdown('hung up locally');
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;

    if (this.pacer) { clearInterval(this.pacer); this.pacer = null; }
    this.queue.length = 0;

    try { this.socket.destroy(); } catch { /* already gone */ }

    this.closeCb?.(reason);
    this.emit('close', reason);
  }
}

/**
 * Listens for Asterisk's external-media connections.
 *
 * One TCP connection per call. `onCall` is handed a transport; whoever receives
 * it owns hanging it up.
 */
export class AudioSocketServer {
  private server: net.Server | null = null;

  constructor(private readonly onCall: (call: AudioSocketCall) => void) {}

  listen(port: number, host = '0.0.0.0'): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer(socket => {
        const ref  = `${socket.remoteAddress}:${socket.remotePort}`;
        const call = new AudioSocketCall(socket, { callRef: '' });
        console.log(`[AUDIOSOCKET] call connected from ${ref}`);

        try {
          this.onCall(call);
        } catch (err) {
          console.error('[AUDIOSOCKET] call handler threw:', err);
          call.hangup();
        }
      });

      server.on('error', reject);
      server.listen(port, host, () => {
        console.log(`[AUDIOSOCKET] listening on ${host}:${port}`);
        this.server = server;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise(resolve => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  get port(): number | null {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : null;
  }
}
