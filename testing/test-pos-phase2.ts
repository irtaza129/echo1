// Phase 2 money maths.
//
//   npx tsx testing/test-pos-phase2.ts                    # pure maths only, no DB
//   npx tsx --env-file=.env testing/test-pos-phase2.ts --live --tenant <uuid>
//
// The pure half runs anywhere and is what CI should gate on. The --live half
// drives a real order through Postgres — create, add a round, discount, void a
// line — and deletes everything it made in a finally block.

import assert from 'node:assert';
import { computeTotals, type NewOrderItem } from '../src/lib/posRepo.js';

let passed = 0, failed = 0;
const section = (n: string) => console.log(n);
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${(err as Error).message}`); failed++; }
}

const item = (unitPrice: number, quantity = 1, lineDiscount = 0): NewOrderItem =>
  ({ dishName: 'x', unitPrice, quantity, lineDiscount });

// ── Pure maths ───────────────────────────────────────────────────────────────

section('order totals');

await check('subtotal is quantity × price', () => {
  const t = computeTotals([item(100, 3)], 0);
  assert.equal(t.subtotal, 300);
  assert.equal(t.total, 300);
});

await check('a line discount comes off the subtotal', () => {
  const t = computeTotals([item(100, 2, 30)], 0);
  assert.equal(t.subtotal, 170, '200 minus a 30 line discount');
});

await check('tax is charged on the discounted amount, not the gross', () => {
  // Taxing the pre-discount figure overcharges the customer and is the single
  // most common tax bug in a POS.
  const t = computeTotals([item(1000)], 0.15, { discount: 200 });
  assert.equal(t.discount, 200);
  assert.equal(t.tax, 120, '15% of 800, not of 1000');
  assert.equal(t.total, 920);
});

await check('service charge is on the net, and is itself taxed', () => {
  const t = computeTotals([item(1000)], 0.15, { serviceChargeRate: 0.10 });
  assert.equal(t.serviceCharge, 100);
  assert.equal(t.tax, 165, '15% of (1000 + 100)');
  assert.equal(t.total, 1265);
});

await check('delivery fee is added after tax, not taxed', () => {
  const t = computeTotals([item(1000)], 0.15, { deliveryFee: 150 });
  assert.equal(t.tax, 150, 'tax is on the food only');
  assert.equal(t.total, 1300, '1000 + 150 tax + 150 delivery');
});

await check('a discount larger than the subtotal cannot make the total negative', () => {
  // A manager fat-fingering 10000 into the discount box must not produce an
  // order the business owes money on.
  const t = computeTotals([item(500)], 0.15, { discount: 10_000 });
  assert.equal(t.total >= 0, true, `total was ${t.total}`);
  assert.equal(t.tax, 0);
});

await check('every figure is rounded to 2dp', () => {
  const t = computeTotals([item(33.333, 3)], 0.175);
  for (const [k, v] of Object.entries(t)) {
    assert.equal(Math.round(v * 100) / 100, v, `${k} carried more than 2dp: ${v}`);
  }
});

await check('the parts sum to the total', () => {
  // The receipt prints these lines individually; if they do not add up to the
  // printed total, the customer is the one who notices.
  for (const gst of [0, 0.05, 0.15, 0.175]) {
    for (const svc of [0, 0.1]) {
      const t = computeTotals([item(123.45, 2), item(67.89, 3, 10)], gst,
        { discount: 25, serviceChargeRate: svc, deliveryFee: 50 });
      const sum = Math.round((t.subtotal - t.discount + t.serviceCharge + t.tax + 50) * 100) / 100;
      assert.equal(sum, t.total, `gst=${gst} svc=${svc}: parts ${sum} ≠ total ${t.total}`);
    }
  }
});

await check('an empty order is all zeroes, not NaN', () => {
  const t = computeTotals([], 0.15, { serviceChargeRate: 0.1 });
  for (const [k, v] of Object.entries(t)) {
    assert.equal(Number.isFinite(v), true, `${k} was ${v}`);
    assert.equal(v, 0, `${k} should be 0`);
  }
});

// ── Live round-trip ──────────────────────────────────────────────────────────

if (process.argv.includes('--live')) {
  const tenantId = process.argv[process.argv.indexOf('--tenant') + 1];
  if (!tenantId) {
    console.error('\n--live needs --tenant <uuid>');
    process.exit(1);
  }

  const { ordersRepo } = await import('../src/lib/posRepo.js');
  const db = await import('../src/lib/supabaseAdmin.js');

  section('\nlive order round-trip');
  let orderId: string | null = null;

  try {
    await check('create → add a round → discount → void a line', async () => {
      const rates = { gstRate: 0.15, serviceChargeRate: 0 };

      const created = await ordersRepo.create({
        tenantId,
        items: [{ dishName: 'TEST Biryani', quantity: 2, unitPrice: 500 }],
        gstRate: rates.gstRate,
        orderType: 'dine_in',
        source: 'pos',
        customerName: 'PHASE2 TEST',
      });
      orderId = created.order.id;
      assert.equal(created.totals.subtotal, 1000);
      assert.equal(created.totals.total, 1150, '1000 + 15%');

      // Add a second round to the open tab.
      const added = await ordersRepo.addItems(tenantId, orderId, [
        { dishName: 'TEST Cola', quantity: 3, unitPrice: 100 },
      ], rates);
      assert.equal(added.totals.subtotal, 1300, 'tab grew by 300');
      assert.equal(added.totals.total, 1495);

      // Discount 300 off.
      const discounted = await ordersRepo.applyDiscount(
        tenantId, orderId, 300, 'TEST regular customer', null, rates,
      );
      assert.equal(discounted.totals.discount, 300);
      assert.equal(discounted.totals.tax, 150, '15% of 1000, not of 1300');
      assert.equal(discounted.totals.total, 1150);

      // Void the cola line.
      const items = await ordersRepo.items(orderId);
      const cola  = items.find(i => i.dish_name === 'TEST Cola')!;
      const voided = await ordersRepo.voidItem(
        tenantId, orderId, cola.id, 'TEST spilled', null, rates,
      );
      assert.equal(voided.totals.subtotal, 1000, 'cola removed from the money');
      assert.equal(voided.totals.total, 805, '(1000-300) + 15%');

      // The voided row must still exist for the Z-report.
      const after = await ordersRepo.items(orderId);
      assert.equal(after.length, 2, 'a voided line is kept, never deleted');
      assert.ok(after.find(i => i.id === cola.id)!.voided_at, 'and is marked voided');
    });

    await check('preview does not mutate the order', async () => {
      const rates  = { gstRate: 0.15, serviceChargeRate: 0 };
      const before = await ordersRepo.findById(tenantId, orderId!);
      await ordersRepo.previewDiscount(tenantId, orderId!, 900, rates);
      const after  = await ordersRepo.findById(tenantId, orderId!);
      assert.equal(Number(after!.total_amount), Number(before!.total_amount),
        'a preview must leave the stored total untouched');
    });
  } finally {
    if (orderId) {
      await db.remove('order_items', { order_id: `eq.${orderId}` });
      await db.remove('orders',      { id: `eq.${orderId}` });
      console.log(`  · cleaned up test order ${orderId}`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
