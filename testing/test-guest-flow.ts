// Live guest flow: scan → PIN → session → call waiter.
//
//   npx tsx --env-file=.env testing/test-guest-flow.ts --slug fassih
//
// Mounts the real guest router on a throwaway app and drives it against real
// Postgres, then deletes everything it created. Requires the tenant to have
// channels.qr.enabled and at least one table with a QR issued.

import assert from 'node:assert';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { guestRouter } from '../routes/guest.js';
import * as db from '../src/lib/supabaseAdmin.js';
import { tableQrRepo, type VenueTableRow } from '../src/lib/dineRepo.js';
import { subscribe, type PosEvent } from '../src/lib/posEvents.js';

const slug = process.argv[process.argv.indexOf('--slug') + 1];
if (!slug || slug.startsWith('--')) {
  console.error('Usage: npx tsx --env-file=.env testing/test-guest-flow.ts --slug <slug>');
  process.exit(1);
}

let passed = 0, failed = 0;
const section = (n: string) => console.log(n);
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${(err as Error).message}`); failed++; }
}

const tenant = await db.selectOne<{ id: string; slug: string }>('tenants', {
  slug: `eq.${slug}`, select: 'id,slug',
});
if (!tenant) { console.error(`No tenant "${slug}".`); process.exit(1); }

// A freshly issued table, so this test never depends on a PIN printed earlier.
const tables = await db.selectMany<VenueTableRow>('venue_tables', {
  tenant_id: `eq.${tenant.id}`, order: 'label.asc', limit: '1',
});
if (tables.length === 0) {
  console.error('No tables. Create some: npx tsx --env-file=.env scripts/table-qr.ts --slug ' + slug + ' --add "1"');
  process.exit(1);
}
const table = tables[0];
const { qrToken, pin } = await tableQrRepo.issueCredentials(tenant.id, table.id);

const app = express();
app.use(express.json());
app.use('/api/guest', guestRouter);
const server = app.listen(0);
await new Promise<void>(r => server.once('listening', () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/guest`;

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res  = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

let guestToken = '';
let sessionId  = '';
const events: PosEvent[] = [];
const off = subscribe(tenant.id, e => events.push(e));

section('guest session');

try {
  await check('a wrong PIN is refused', async () => {
    const wrong = pin === '1111' ? '2222' : '1111';
    const r = await call('POST', '/session', { qrToken, pin: wrong });
    assert.equal(r.status, 401);
  });

  await check('an unknown QR token is refused identically', async () => {
    // Same message as a wrong PIN, on purpose: telling them apart reveals
    // whether a photographed code is still live.
    const r = await call('POST', '/session', { qrToken: 'totallyMadeUpToken123', pin });
    assert.equal(r.status, 401);
  });

  await check('the right QR + PIN opens a session', async () => {
    const r = await call('POST', '/session', { qrToken, pin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body as {
      token: string;
      table: { label: string };
      restaurant: { name: string };
      session: { id: string };
    };
    assert.ok(b.token, 'a guest token is issued');
    assert.equal(b.table.label, table.label, 'and it names the right table');
    assert.ok(b.restaurant.name, 'and the restaurant');
    guestToken = b.token;
    sessionId  = b.session.id;
  });

  await check('a second scan of the same table JOINS the same session', async () => {
    // A table of four must share one basket and one bill, not open four tabs.
    const r = await call('POST', '/session', { qrToken, pin });
    assert.equal(r.status, 200);
    assert.equal((r.body as { session: { id: string } }).session.id, sessionId,
      'the second phone should join, not start a new visit');
  });

  await check('guest routes reject a missing token', async () => {
    const r = await call('GET', '/cart');
    assert.equal(r.status, 401);
  });

  await check('the basket starts empty and totals are computed', async () => {
    const r = await call('GET', '/cart', undefined, guestToken);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body as { items: unknown[]; totals: { total: number } };
    assert.equal(Array.isArray(b.items), true);
    assert.equal(b.totals.total, 0, 'an empty basket is zero, not NaN');
  });

  section('call waiter');

  await check('pressing Call Waiter raises a request and an event', async () => {
    events.length = 0;
    const r = await call('POST', '/service-request', { type: 'call_waiter' }, guestToken);
    assert.equal(r.status, 201, JSON.stringify(r.body));

    const evt = events.find(e => e.type === 'service_request.created');
    assert.ok(evt, 'the till must be told immediately');
    assert.equal(evt!.data.tableLabel, table.label,
      'the alert carries the table LABEL, not a uuid — staff carry plates, not uuids');
  });

  await check('pressing it again within the cooldown is refused', async () => {
    const r = await call('POST', '/service-request', { type: 'call_waiter' }, guestToken);
    assert.equal(r.status, 429, 'a child tapping the button must not spam the till');
    assert.ok(Number(r.body.retryAfter) > 0, 'and is told how long to wait');
  });

  section('voice');

  await check('voice session is refused without a guest token', async () => {
    const r = await call('POST', '/voice/session', {});
    assert.equal(r.status, 401);
  });

  await check('voice session mints an ephemeral token and a table-aware prompt', async () => {
    const r = await call('POST', '/voice/session', {}, guestToken);
    if (r.status === 503) {
      console.log('      (skipped — GEMINI_API_KEY not set or Gemini unreachable)');
      return;
    }
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const b = r.body as { token: string; model: string; systemInstruction: string };
    assert.ok(b.token, 'an ephemeral token is returned');
    assert.notEqual(b.token, process.env.GEMINI_API_KEY,
      'the REAL key must never be sent to a phone');
    assert.ok(b.model, 'and the model to connect to');

    // The prompt is built server-side precisely so a phone cannot edit these.
    assert.match(b.systemInstruction, new RegExp('TABLE ' + table.label, 'i'),
      'the prompt names the diner table');
    assert.match(b.systemInstruction, /NEVER ask for a table number/i);
    assert.doesNotMatch(b.systemInstruction, /Is this dine-in, pickup, or takeaway/i,
      'a seated diner is never asked the order type');
  });

  section('order tracking is scoped to the session');

  await check('a guest cannot read an order from another session', async () => {
    // Any uuid that is not theirs must 404, even within the same restaurant.
    const r = await call('GET', '/order/00000000-0000-4000-8000-000000000999/status',
      undefined, guestToken);
    assert.equal(r.status, 404);
  });

  await check('their own order list is empty and scoped', async () => {
    const r = await call('GET', '/orders', undefined, guestToken);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [], 'nothing ordered yet in this session');
  });
} finally {
  off();
  if (sessionId) {
    await db.remove('service_requests', { dine_session_id: `eq.${sessionId}` });
    await db.remove('dine_sessions',     { id: `eq.${sessionId}` });
    console.log(`  · cleaned up session ${sessionId}`);
  }
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
