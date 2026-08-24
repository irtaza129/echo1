import { Router, type Request, type Response } from 'express';
import { subscribe, replaySince, type PosEvent } from '../src/lib/posEvents.js';

// Server-sent events for the POS. Mounted in server.ts behind:
//   requireAuth → attachAdapter → requireFeature('pos')
// so the stream is tenant-scoped by the same chain as every other POS route.
//
// SSE rather than WebSocket: this traffic is one-directional (server → till),
// it survives proxies that mangle upgrades, and it reconnects on its own. A
// WebSocket would buy nothing here and cost an upgrade path through Render.
//
// The browser does NOT use EventSource, because EventSource cannot send an
// Authorization header — the only ways to authenticate it are a token in the
// query string (which lands in access logs) or a cookie (which invites CSRF).
// src/lib/useEventStream.ts reads this with fetch() + ReadableStream instead,
// which keeps the bearer token in a header where it belongs. The wire format
// below is still standard SSE.

export const streamRouter = Router();

// Proxies buffer by default, which turns a live stream into a stalled request.
const HEARTBEAT_MS = 25_000;

function send(res: Response, event: PosEvent): void {
  res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify({ at: event.at, ...event.data })}\n\n`);
}

streamRouter.get('/', (req: Request, res: Response) => {
  const tenantId = req.tenantConfig!.tenantId;

  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-store, no-transform',
    Connection:          'keep-alive',
    // Nginx buffers proxied responses unless told not to; without this the
    // client receives nothing until the response ends, which for a stream is
    // never.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // Replay anything missed across a reconnect. The header is the standard one
  // browsers resend; our fetch-based client sets it explicitly.
  const rawLast = req.header('Last-Event-ID') ?? (req.query.lastEventId as string | undefined);
  const lastId  = rawLast !== undefined && /^\d+$/.test(rawLast) ? Number(rawLast) : null;
  const { events, gap } = replaySince(tenantId, lastId);

  // Tell the client to refetch rather than pretending it is current. A silent
  // partial replay is how a till ends up permanently missing table 6's order.
  res.write(`event: hello\ndata: ${JSON.stringify({ resync: gap || lastId === null })}\n\n`);
  for (const e of events) send(res, e);

  const unsubscribe = subscribe(tenantId, e => {
    try { send(res, e); } catch { /* client vanished mid-write; close handles it */ }
  });

  // A comment line is a valid SSE keep-alive and is ignored by the parser. It
  // stops idle proxies and load balancers from reaping the connection.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ditto */ }
  }, HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };

  // Both matter: 'close' fires when the client goes away, 'error' when the
  // socket breaks. Leaking either the listener or the timer would keep this
  // tenant's channel alive forever and slowly grow the process.
  req.on('close', cleanup);
  res.on('error', cleanup);
});
