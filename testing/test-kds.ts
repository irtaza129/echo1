// Live kitchen-display flow against real Postgres.
//
//   npx tsx --env-file=.env testing/test-kds.ts --tenant <uuid>
//
// Creates an order, works it through the board, and deletes everything in a
// finally. The behaviour worth pinning down is the cascade: bumping the LAST
// line is what makes an order ready, and recalling one must take that back.

import assert from 'node:assert';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { AddressInfo } from 'node:net';
import { posRouter } from '../routes/pos.js';
import * as db from '../src/lib/supabaseAdmin.js';
import { ordersRepo } from '../src/lib/posRepo.js';
import { subscribe, type PosEvent } from '../src/lib/posEvents.js';

const tenantId = process.argv[process.argv.indexOf('--tenant') + 1];
if (!tenantId || tenantId.startsWith('--')) {
  console.error('Usage: npx tsx --env-file=.env testing/test-kds.ts --tenant <uuid>');
  process.exit(1);
}

let passed = 0, failed = 0;
const section = (n: string) => console.log(n);
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${(err as Error).message}`); failed++; }
}

const app = express();
app.use(express.json());
app.use('/api/pos', (req: Request, _res: Response, next: NextFunction) => {
  (req as Request & { tenantConfig?: unknown; jwtPayload?: unknown }).tenantConfig = {
    tenantId,
    restaurantName: 'KDS Test',
    businessRules: { gstRate: 0.15, currencySymbol: 'PKR', pos: { serviceChargeRate: 0 } },
  };
  (req as Request & { jwtPayload?: unknown }).jwtPayload = {
    sub: 'kds-test', tenantId, role: 'tenant_admin', slug: 'test',
  };
  next();
}, posRouter);

const server = app.listen(0);
await new Promise<void>(r => server.once('listening', () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/pos`;

async function call(method: string, path: string, body?: unknown) {
  const res  = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body:    body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

interface Ticket {
  orderId: string; orderNumber: number | null;
  lines: Array<{ itemId: string; name: string; quantity: number; notes: string | null }>;
}

let orderId: string | null = null;
const events: PosEvent[] = [];
const off = subscribe(tenantId, e => events.push(e));

try {
  await check('a new order appears on the board with all its lines', async () => {
    const created = await ordersRepo.create({
      tenantId,
      items: [
        { dishName: 'KDSTEST Karahi', quantity: 1, unitPrice: 750, notes: 'no onions' },
        { dishName: 'KDSTEST Naan',   quantity: 3, unitPrice: 50 },
      ],
      gstRate: 0.15, orderType: 'dine_in', source: 'pos', customerName: 'KDSTEST',
    });
    orderId = created.order.id;

    const r = await call('GET', '/kds/tickets');
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const tickets = r.body as unknown as Ticket[];
    const mine = tickets.find(t => t.orderId === orderId);
    assert.ok(mine, 'the order should be on the board');
    assert.equal(mine!.lines.length, 2);
    assert.ok(mine!.lines.some(l => l.notes === 'no onions'),
      'notes must reach the kitchen — missing one sends the plate back');
  });

  await check('bumping one line leaves the order still cooking', async () => {
    const tickets = (await call('GET', '/kds/tickets')).body as unknown as Ticket[];
    const mine    = tickets.find(t => t.orderId === orderId)!;
    const naan    = mine.lines.find(l => l.name === 'KDSTEST Naan')!;

    const r = await call('POST', `/kds/items/${naan.itemId}/bump`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.orderReady, false, 'the karahi is still to come');

    const order = await ordersRepo.findById(tenantId, orderId!);
    assert.notEqual(order!.status, 'ready', 'the order must NOT be ready yet');
  });

  await check('a bumped line disappears from the board', async () => {
    const tickets = (await call('GET', '/kds/tickets')).body as unknown as Ticket[];
    const mine    = tickets.find(t => t.orderId === orderId)!;
    assert.equal(mine.lines.length, 1);
    assert.equal(mine.lines[0].name, 'KDSTEST Karahi');
  });

  await check('bumping the LAST line makes the order ready', async () => {
    events.length = 0;
    const tickets = (await call('GET', '/kds/tickets')).body as unknown as Ticket[];
    const karahi  = tickets.find(t => t.orderId === orderId)!.lines[0];

    const r = await call('POST', `/kds/items/${karahi.itemId}/bump`);
    assert.equal(r.body.orderReady, true, 'nothing left to cook → the order is ready');

    const order = await ordersRepo.findById(tenantId, orderId!);
    assert.equal(order!.status, 'ready');

    const evt = events.find(e => e.type === 'order.status' && e.data.status === 'ready');
    assert.ok(evt, 'the front counter and the diner tracking screen need telling');
  });

  await check('a fully bumped order leaves the board', async () => {
    const tickets = (await call('GET', '/kds/tickets')).body as unknown as Ticket[];
    assert.ok(!tickets.some(t => t.orderId === orderId),
      'nothing left to cook means nothing to show');
  });

  await check('recall puts a line back and un-readies the order', async () => {
    // Bumping is one tap and mistakes happen. Without recall the only recovery
    // is re-ringing the item, which double-charges for a kitchen error.
    const items  = await ordersRepo.items(orderId!);
    const karahi = items.find(i => i.dish_name === 'KDSTEST Karahi')!;

    const r = await call('POST', `/kds/items/${karahi.id}/recall`);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const order = await ordersRepo.findById(tenantId, orderId!);
    assert.equal(order!.status, 'preparing', 'a recalled line means it is not ready after all');

    const tickets = (await call('GET', '/kds/tickets')).body as unknown as Ticket[];
    const mine    = tickets.find(t => t.orderId === orderId);
    assert.ok(mine, 'and it is back on the board');
    assert.equal(mine!.lines.length, 1);
  });

  await check('a voided line never reaches the kitchen', async () => {
    const items = await ordersRepo.items(orderId!);
    const naan  = items.find(i => i.dish_name === 'KDSTEST Naan')!;

    await db.update('order_items', { id: `eq.${naan.id}` }, {
      voided_at: new Date().toISOString(), void_reason: 'test', bumped_at: null,
    });

    const tickets = (await call('GET', '/kds/tickets')).body as unknown as Ticket[];
    const mine    = tickets.find(t => t.orderId === orderId)!;
    assert.ok(!mine.lines.some(l => l.name === 'KDSTEST Naan'),
      'a voided line must not be cooked, even though it is unbumped');
  });

  section('printing');

  await check('printing with no printer configured returns the bytes to fall back on', async () => {
    // A till with no network printer is normal in a small restaurant. Refusing
    // outright would leave them with no receipt at all.
    const r = await call('POST', `/orders/${orderId}/print`, { kind: 'receipt' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, false);
    assert.match(String(r.body.reason), /no printer/i);

    const payload = Buffer.from(String(r.body.payload), 'base64').toString('latin1');
    assert.ok(payload.includes('KDS Test'), 'the receipt should carry the restaurant name');
    assert.ok(payload.includes('TOTAL'));
  });

  await check('a kitchen ticket carries no money', async () => {
    const r = await call('POST', `/orders/${orderId}/print`, { kind: 'kitchen' });
    const payload = Buffer.from(String(r.body.payload), 'base64').toString('latin1');
    assert.ok(payload.includes('KDSTEST Karahi'));
    assert.ok(!payload.includes('TOTAL'), 'a kitchen ticket must not show money');
    assert.ok(payload.includes('REPRINT'), 'and a reprint must say so');
  });
} finally {
  off();
  if (orderId) {
    await db.remove('order_items', { order_id: `eq.${orderId}` });
    await db.remove('orders',      { id: `eq.${orderId}` });
    console.log(`  · cleaned up order ${orderId}`);
  }
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
