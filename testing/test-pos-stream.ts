// Integration test for the POS event stream over real HTTP.
//
//   npx tsx testing/test-pos-stream.ts
//
// Mounts routes/stream.ts on a throwaway Express app with a stubbed tenant
// context, so it exercises the actual SSE framing, replay and cleanup without
// needing Postgres, Redis or a login. The unit tests cover the bus itself; this
// covers the wire, which is where SSE usually goes wrong.

import assert from 'node:assert';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { AddressInfo } from 'node:net';
import { streamRouter } from '../routes/stream.js';
import { publish, listenerCount } from '../src/lib/posEvents.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${(err as Error).message}`); failed++; }
}

const TENANT = '00000000-0000-4000-8000-00000000beef';

const app = express();
app.use('/api/pos/stream', (req: Request, _res: Response, next: NextFunction) => {
  // Stand in for requireAuth → attachAdapter.
  (req as Request & { tenantConfig?: unknown }).tenantConfig = { tenantId: TENANT };
  next();
}, streamRouter);

const server = app.listen(0);
await new Promise<void>(r => server.once('listening', () => r()));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/api/pos/stream`;

// ── A tiny SSE reader ────────────────────────────────────────────────────────

interface Frame { id?: string; event: string; data?: Record<string, unknown> }

function openStream(headers: Record<string, string> = {}) {
  const abort  = new AbortController();
  const frames: Frame[] = [];
  let buffer = '';

  const ready = (async () => {
    const res = await fetch(base, { headers, signal: abort.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(res.headers.get('x-accel-buffering'), 'no', 'must disable proxy buffering');

    const reader  = res.body!.getReader();
    const decoder = new TextDecoder();

    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';
          for (const p of parts) {
            const f = parseFrame(p);
            if (f) frames.push(f);
          }
        }
      } catch { /* aborted */ }
    })();
  })();

  return { ready, frames, close: () => abort.abort() };
}

function parseFrame(frame: string): Frame | null {
  let id: string | undefined;
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    if (i === -1) continue;
    const field = line.slice(0, i);
    const value = line.slice(i + 1).replace(/^ /, '');
    if (field === 'id')    id = value;
    if (field === 'event') event = value;
    if (field === 'data')  data.push(value);
  }
  if (!data.length) return id ? { id, event } : null;
  return { id, event, data: JSON.parse(data.join('\n')) as Record<string, unknown> };
}

const settle = (ms = 120) => new Promise(r => setTimeout(r, ms));

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('pos event stream (HTTP)');

await check('opens with a hello frame asking a fresh client to resync', async () => {
  const s = openStream();
  await s.ready;
  await settle();
  assert.equal(s.frames[0].event, 'hello');
  assert.equal(s.frames[0].data?.resync, true, 'a first connection has no baseline');
  s.close();
});

await check('delivers a published event as a typed SSE frame', async () => {
  const s = openStream();
  await s.ready;
  await settle();

  publish(TENANT, 'order.created', { orderId: 'abc', total: 12.5 });
  await settle();

  const f = s.frames.find(x => x.event === 'order.created');
  assert.ok(f, 'order.created frame should arrive');
  assert.equal(f!.data?.orderId, 'abc');
  assert.equal(f!.data?.total, 12.5);
  assert.ok(f!.data?.at, 'every frame carries a timestamp');
  assert.ok(f!.id, 'every frame carries an id for Last-Event-ID');
  s.close();
});

await check('does not deliver another tenant\'s events', async () => {
  const s = openStream();
  await s.ready;
  await settle();

  publish('00000000-0000-4000-8000-00000000cafe', 'order.created', { orderId: 'other' });
  await settle();

  assert.equal(s.frames.some(f => f.data?.orderId === 'other'), false);
  s.close();
});

await check('replays missed events from Last-Event-ID', async () => {
  const first = openStream();
  await first.ready;
  await settle();
  publish(TENANT, 'order.status', { n: 1 });
  await settle();

  const lastId = first.frames.filter(f => f.id).pop()!.id!;
  first.close();
  await settle();

  // Two events happen while nobody is connected.
  publish(TENANT, 'order.status', { n: 2 });
  publish(TENANT, 'order.status', { n: 3 });

  const second = openStream({ 'Last-Event-ID': lastId });
  await second.ready;
  await settle();

  const hello = second.frames.find(f => f.event === 'hello');
  assert.equal(hello?.data?.resync, false, 'a fillable gap must not force a full resync');

  const ns = second.frames.filter(f => f.event === 'order.status').map(f => f.data?.n);
  assert.deepEqual(ns, [2, 3], 'exactly the missed events, in order');
  second.close();
});

await check('an unfillable gap tells the client to resync', async () => {
  const s = openStream({ 'Last-Event-ID': '999999' });
  await s.ready;
  await settle();
  assert.equal(s.frames[0].event, 'hello');
  assert.equal(s.frames[0].data?.resync, true);
  s.close();
});

await check('a garbage Last-Event-ID is treated as a fresh connection', async () => {
  const s = openStream({ 'Last-Event-ID': 'not-a-number' });
  await s.ready;
  await settle();
  assert.equal(s.frames[0].data?.resync, true);
  s.close();
});

await check('closing the connection detaches its listener', async () => {
  // Let any connection closed by an earlier test finish tearing down, so the
  // baseline is stable. Without this the assertion races previous cleanups and
  // fails for a reason that has nothing to do with leaking.
  await settle(300);
  const before = listenerCount(TENANT);

  const s = openStream();
  await s.ready;
  await settle();
  assert.equal(listenerCount(TENANT), before + 1, 'connection should attach exactly one listener');

  s.close();
  await settle(300);
  assert.equal(listenerCount(TENANT), before,
    'a closed connection must not leak its listener or its heartbeat');
});

await check('repeated connect/disconnect cycles leak nothing', async () => {
  // The leak that matters in production is cumulative: a terminal on flaky
  // wifi reconnects hundreds of times a day, and one listener left behind per
  // cycle would eventually flood every publish.
  await settle(300);
  const before = listenerCount(TENANT);

  for (let i = 0; i < 5; i++) {
    const s = openStream();
    await s.ready;
    await settle(60);
    s.close();
    await settle(60);
  }

  await settle(300);
  assert.equal(listenerCount(TENANT), before,
    `after 5 connect/disconnect cycles the listener count must return to ${before}`);
});

await check('several terminals all receive the same event', async () => {
  const a = openStream(), b = openStream(), c = openStream();
  await Promise.all([a.ready, b.ready, c.ready]);
  await settle();

  publish(TENANT, 'order.paid', { orderId: 'shared' });
  await settle();

  for (const [name, s] of [['a', a], ['b', b], ['c', c]] as const) {
    assert.ok(s.frames.some(f => f.data?.orderId === 'shared'), `terminal ${name} missed the event`);
  }
  a.close(); b.close(); c.close();
  await settle(250);
});

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
