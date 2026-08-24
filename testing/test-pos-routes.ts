// Live route test for the till: drives a real order through the real HTTP
// handlers against real Postgres, then deletes everything it made.
//
//   npx tsx --env-file=.env testing/test-pos-routes.ts --tenant <uuid>
//
// posRouter is mounted on a throwaway Express app with requireAuth/attachAdapter
// stubbed, because those are already covered elsewhere and standing up a login
// here would test the login, not the till.

import assert from 'node:assert';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { AddressInfo } from 'node:net';
import { posRouter } from '../routes/pos.js';
import * as db from '../src/lib/supabaseAdmin.js';

const tenantId = process.argv[process.argv.indexOf('--tenant') + 1];
if (!tenantId || tenantId.startsWith('--')) {
  console.error('Usage: npx tsx --env-file=.env testing/test-pos-routes.ts --tenant <uuid>');
  process.exit(1);
}

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${(err as Error).message}`); failed++; }
}

const app = express();
app.use(express.json());
app.use('/api/pos', (req: Request, _res: Response, next: NextFunction) => {
  (req as Request & { tenantConfig?: unknown; jwtPayload?: unknown }).tenantConfig = {
    tenantId,
    businessRules: { gstRate: 0.15, currencySymbol: 'PKR', pos: { serviceChargeRate: 0 } },
  };
  (req as Request & { jwtPayload?: unknown }).jwtPayload = {
    sub: 'test-runner', tenantId, role: 'tenant_admin', slug: 'test',
  };
  next();
}, posRouter);

const server = app.listen(0);
await new Promise<void>(r => server.once('listening', () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/pos`;

async function call(method: string, path: string, body?: unknown) {
  const res  = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body:    body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

let orderId: string | null = null;
let shiftId: string | null = null;
let openedShiftHere = false;

console.log('till routes (live)');

try {
  await check('a shift is open (opening one if needed)', async () => {
    const cur = await call('GET', '/shifts/current');
    assert.equal(cur.status, 200);

    const existing = (cur.body as { shift?: { id: string } }).shift;
    if (existing) { shiftId = existing.id; return; }

    const opened = await call('POST', '/shifts/open', { openingFloat: 1000 });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    shiftId = (opened.body as { shift: { id: string } }).shift.id;
    openedShiftHere = true;
  });

  await check('POST /orders creates an order with server-computed totals', async () => {
    const r = await call('POST', '/orders', {
      items: [{ dishName: 'ROUTETEST Karahi', quantity: 2, unitPrice: 750 }],
      orderType: 'takeaway',
      customerName: 'ROUTETEST',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { order, totals } = r.body as { order: { id: string }; totals: { subtotal: number; total: number } };
    orderId = order.id;
    assert.equal(totals.subtotal, 1500);
    assert.equal(totals.total, 1725, '1500 + 15%');
  });

  await check('POST /quote matches what the order was written with', async () => {
    // The till prices a basket with /quote before placing it. If the two ever
    // disagree, the customer is quoted one number and charged another.
    const q = await call('POST', '/quote', {
      items: [{ dishName: 'ROUTETEST Karahi', quantity: 2, unitPrice: 750 }],
    });
    assert.equal(q.status, 200);
    assert.equal((q.body as { total: number }).total, 1725);
  });

  await check('POST /orders/:id/items grows the open tab', async () => {
    const r = await call('POST', `/orders/${orderId}/items`, {
      items: [{ dishName: 'ROUTETEST Naan', quantity: 4, unitPrice: 50 }],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { totals } = r.body as { totals: { subtotal: number; total: number } };
    assert.equal(totals.subtotal, 1700);
    assert.equal(totals.total, 1955);
  });

  await check('voiding a line without a manager PIN is refused', async () => {
    const items = await call('GET', `/orders/${orderId}`);
    const naan  = (items.body as { items: Array<{ id: string; dish_name: string }> })
      .items.find(i => i.dish_name === 'ROUTETEST Naan')!;

    const r = await call('POST', `/orders/${orderId}/items/${naan.id}/void`, { reason: 'test' });
    assert.equal(r.status, 401, 'no PIN must be rejected');
    assert.match(String(r.body.error), /manager PIN/i);
  });

  await check('a wrong manager PIN is refused', async () => {
    const items = await call('GET', `/orders/${orderId}`);
    const naan  = (items.body as { items: Array<{ id: string; dish_name: string }> })
      .items.find(i => i.dish_name === 'ROUTETEST Naan')!;

    const r = await call('POST', `/orders/${orderId}/items/${naan.id}/void`, {
      reason: 'test', approvalPin: '000000',
    });
    assert.equal(r.status, 401, JSON.stringify(r.body));
  });

  await check('split tender: part cash, part card, then settled', async () => {
    const first = await call('POST', `/orders/${orderId}/payments`, {
      method: 'cash', amount: 1000, tendered: 2000,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const f = first.body as { settled: boolean; due: number; payment: { change_due: string | number } };
    assert.equal(f.settled, false);
    assert.equal(f.due, 955);
    assert.equal(Number(f.payment.change_due), 1000, 'change on a 2000 note against 1000');

    const second = await call('POST', `/orders/${orderId}/payments`, {
      method: 'card', amount: 955,
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const s = second.body as { settled: boolean; due: number };
    assert.equal(s.settled, true);
    assert.equal(s.due, 0);
  });

  await check('over-tendering past the amount due is rejected', async () => {
    const r = await call('POST', `/orders/${orderId}/payments`, { method: 'cash', amount: 500 });
    assert.equal(r.status, 400, 'a settled order has nothing left to pay');
    assert.match(String(r.body.error), /exceeds/i);
  });

  await check('GET /shifts/:id/report returns an X report that reconciles', async () => {
    const r = await call('GET', `/shifts/${shiftId}/report`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { report, kind } = r.body as {
      kind: string;
      report: {
        tenders: Array<{ method: string; net: number }>;
        sales: { total: number };
        expectedCash: number;
        openingFloat: number;
      };
    };
    assert.equal(kind, 'X', 'the shift is still open');

    const cash = report.tenders.find(t => t.method === 'cash');
    const card = report.tenders.find(t => t.method === 'card');
    assert.ok(cash && cash.net >= 1000, 'cash tender should appear');
    assert.ok(card && card.net >= 955, 'card tender should appear');

    // The drawer figure must count cash only. Including card tender here is the
    // classic reason a Z-report never balances.
    assert.equal(
      report.expectedCash >= report.openingFloat + 1000, true,
      'expected cash includes the cash tender',
    );
    assert.equal(
      report.expectedCash < report.openingFloat + 1000 + 955, true,
      'expected cash must NOT include the card tender',
    );
  });
} finally {
  if (orderId) {
    await db.remove('pos_payments', { order_id: `eq.${orderId}` });
    await db.remove('order_items',  { order_id: `eq.${orderId}` });
    await db.remove('orders',       { id: `eq.${orderId}` });
    console.log(`  · cleaned up order ${orderId}`);
  }
  if (shiftId && openedShiftHere) {
    await db.remove('pos_cash_movements', { shift_id: `eq.${shiftId}` });
    await db.remove('pos_shifts',         { id: `eq.${shiftId}` });
    console.log(`  · cleaned up shift ${shiftId}`);
  }
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
