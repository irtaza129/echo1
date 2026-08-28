import { useEffect, useRef, useState } from 'react';

// Client for the POS event stream (routes/stream.ts).
//
// Built on fetch() + ReadableStream rather than EventSource, deliberately.
// EventSource cannot set request headers, so authenticating it means putting
// the JWT in the query string — where it lands in proxy and server access logs
// — or in a cookie, which invites CSRF on every other route. fetch keeps the
// bearer token in an Authorization header and lets us send X-Tenant-ID too, so
// the stream is authenticated exactly like every other call in apiClient.ts.
//
// What we give up is EventSource's automatic reconnect, so it is reimplemented
// below with backoff and Last-Event-ID resume.

export interface StreamEvent {
  type: string;
  data: Record<string, unknown>;
}

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

interface Options {
  /**
   * Called when the server says the client cannot be brought up to date from
   * the replay buffer — first connection, or a gap too large to fill.
   *
   * Screens MUST refetch their state here. Treating a resync as "nothing
   * happened" is how a terminal ends up permanently missing an order.
   */
  onResync?: () => void;
  enabled?:  boolean;
}

const MAX_BACKOFF_MS = 30_000;

export function useEventStream(
  onEvent: (e: StreamEvent) => void,
  { onResync, enabled = true }: Options = {},
): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('closed');

  // Held in refs so a change of callback identity never tears down a live
  // connection — a parent re-render must not drop the stream.
  const onEventRef  = useRef(onEvent);
  const onResyncRef = useRef(onResync);
  onEventRef.current  = onEvent;
  onResyncRef.current = onResync;

  useEffect(() => {
    if (!enabled) { setStatus('closed'); return; }

    const abort = new AbortController();
    let lastEventId: string | null = null;
    let attempt   = 0;
    let stopped   = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    async function connect(): Promise<void> {
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting');

      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      const jwt      = sessionStorage.getItem('sf_jwt');
      const tenantId = jwt ? claimsOf(jwt)?.tenantId : undefined;
      if (jwt)      headers.Authorization  = `Bearer ${jwt}`;
      if (tenantId) headers['X-Tenant-ID'] = tenantId;
      if (lastEventId) headers['Last-Event-ID'] = lastEventId;

      const res = await fetch('/api/pos/stream', { headers, signal: abort.signal });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

      setStatus('open');
      attempt = 0;                       // a successful open resets the backoff

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer    = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error('stream ended');

        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line. Anything after the last
        // separator is a partial frame and stays in the buffer.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const parsed = parseFrame(frame);
          if (!parsed) continue;         // heartbeat comment, or unparseable

          if (parsed.id) lastEventId = parsed.id;

          if (parsed.event === 'hello') {
            if (parsed.data?.resync) onResyncRef.current?.();
            continue;
          }
          onEventRef.current({
            type: parsed.event,
            data: parsed.data ?? {},
          });
        }
      }
    }

    function scheduleRetry(err: unknown): void {
      if (stopped || abort.signal.aborted) return;
      setStatus('reconnecting');

      // Exponential backoff with jitter, capped. Jitter matters: without it a
      // restaurant's dozen terminals all reconnect on the same tick and
      // stampede the server that just came back.
      const base  = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
      const delay = base * (0.5 + Math.random() * 0.5);
      attempt += 1;

      console.warn(`[POS-STREAM] disconnected (${String(err)}); retrying in ${Math.round(delay)}ms`);
      retryTimer = setTimeout(run, delay);
    }

    function run(): void {
      connect().catch(scheduleRetry);
    }

    run();

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      abort.abort();
      setStatus('closed');
    };
  }, [enabled]);

  return status;
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface ParsedFrame {
  id?:    string;
  event:  string;
  data?:  Record<string, unknown>;
}

function parseFrame(frame: string): ParsedFrame | null {
  let id: string | undefined;
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;   // keep-alive comment
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, '');

    if (field === 'id')    id = value;
    if (field === 'event') event = value;
    if (field === 'data')  dataLines.push(value);
  }

  if (dataLines.length === 0) return id ? { id, event } : null;

  try {
    return { id, event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> };
  } catch {
    console.warn('[POS-STREAM] unparseable frame data');
    return { id, event };
  }
}

/** Decode a JWT payload without verifying it — for reading our own tenantId. */
function claimsOf(token: string): { tenantId?: string } | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const pad = (4 - part.length % 4) % 4;
    return JSON.parse(atob(part + '='.repeat(pad))) as { tenantId?: string };
  } catch {
    return null;
  }
}
