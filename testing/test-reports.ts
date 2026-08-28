// Sales reporting: the CSV writer (pure) and the live RPC.
//
//   npx tsx testing/test-reports.ts                        # CSV only
//   npx tsx --env-file=.env testing/test-reports.ts --live --tenant <uuid>

import assert from 'node:assert';
import { toCsv, type SalesReport } from '../src/lib/reportsRepo.js';

let passed = 0, failed = 0;
const section = (n: string) => console.log(n);
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${(err as Error).message}`); failed++; }
}

const sample: SalesReport = {
  from: '2026-08-01T00:00:00Z', to: '2026-08-31T23:59:59Z',
  orders: 57, subtotal: 69230, discount: 0, serviceCharge: 0,
  tax: 0, total: 69230, averageOrder: 1214.56,
  voidedCount: 2, voidedValue: 1500,
  bySource:    [{ source: 'kiosk', orders: 50, total: 60000 }, { source: 'qr', orders: 7, total: 9230 }],
  byOrderType: [{ order_type: 'dine_in', orders: 53, total: 66790 }],
  byTender:    [{ method: 'cash', count: 40, gross: 50000, refunded: 500, net: 49500 }],
  byHour:      [{ hour: 21, orders: 9, total: 15515 }],
  topItems:    [{ dish_name: 'Special Choice Pulao', quantity: 9, revenue: 5250 }],
  byStaff:     [],
};

section('CSV export');

await check('carries every section', () => {
  const csv = toCsv(sample);
  for (const s of ['Sales report', 'Summary', 'Channel', 'Order type', 'Tender', 'Hour', 'Item']) {
    assert.ok(csv.includes(s), `missing section "${s}"`);
  }
});

await check('carries the figures', () => {
  const csv = toCsv(sample);
  assert.ok(csv.includes('69230'));
  assert.ok(csv.includes('1214.56'));
  assert.ok(csv.includes('kiosk'));
  assert.ok(csv.includes('Special Choice Pulao'));
});

await check('voids are reported, not silently dropped', () => {
  // A day with thirty voids is telling you something.
  const csv = toCsv(sample);
  assert.ok(csv.includes('Voided orders'));
  assert.ok(csv.includes('Voided value'));
});

await check('uses CRLF line endings', () => {
  assert.ok(toCsv(sample).includes('\r\n'), 'Excel expects CRLF');
});

await check('fields containing commas or quotes are escaped', () => {
  const csv = toCsv({
    ...sample,
    topItems: [{ dish_name: 'Karahi, "large"', quantity: 1, revenue: 100 }],
  });
  assert.ok(csv.includes('"Karahi, ""large"""'),
    'a comma or quote inside a field must not break the column layout');
});

await check('formula injection is neutralised', () => {
  // THE test. A dish literally named "=Special" becomes an executable cell in
  // a file a manager opens without thinking. The leading quote makes it inert
  // and is invisible in the cell.
  for (const dangerous of ['=1+1', '+SUM(A1)', '-2+3', '@SUM(A1)']) {
    const csv = toCsv({
      ...sample,
      topItems: [{ dish_name: dangerous, quantity: 1, revenue: 1 }],
    });
    assert.ok(csv.includes(`'${dangerous}`),
      `"${dangerous}" must be prefixed with a quote to stay inert`);
  }
});

await check('a newline inside a field is quoted, not left to split the row', () => {
  const csv = toCsv({
    ...sample,
    topItems: [{ dish_name: 'Line one\nLine two', quantity: 1, revenue: 1 }],
  });
  assert.ok(csv.includes('"Line one\nLine two"'));
});

await check('an empty report still produces a readable file', () => {
  const empty: SalesReport = {
    ...sample, orders: 0, subtotal: 0, total: 0, averageOrder: 0,
    voidedCount: 0, voidedValue: 0,
    bySource: [], byOrderType: [], byTender: [], byHour: [], topItems: [], byStaff: [],
  };
  const csv = toCsv(empty);
  assert.ok(csv.includes('Sales report'));
  assert.ok(!csv.includes('undefined'), 'a quiet day must not export the word undefined');
  assert.ok(!csv.includes('NaN'));
});

// ── Live ─────────────────────────────────────────────────────────────────────

if (process.argv.includes('--live')) {
  const tenantId = process.argv[process.argv.indexOf('--tenant') + 1];
  if (!tenantId) { console.error('\n--live needs --tenant <uuid>'); process.exit(1); }

  const { reportsRepo } = await import('../src/lib/reportsRepo.js');
  section('\nlive report');

  await check('the RPC returns a fully-typed report', async () => {
    const from = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const to   = new Date(Date.now() + 86_400_000).toISOString();
    const r    = await reportsRepo.summary(tenantId, from, to);

    // Every numeric must be a NUMBER: PostgREST returns some numerics as
    // strings, and "1214.56" + 1 is "1214.561".
    for (const [k, v] of Object.entries(r)) {
      if (['from', 'to'].includes(k)) continue;
      if (Array.isArray(v)) continue;
      assert.equal(typeof v, 'number', `${k} should be a number, got ${typeof v}`);
      assert.ok(Number.isFinite(v as number), `${k} is not finite`);
    }
    assert.ok(Array.isArray(r.bySource));
    assert.ok(Array.isArray(r.topItems));
    console.log(`      (${r.orders} orders, total ${r.total})`);
  });

  await check('an empty range returns zeroes, not nulls', async () => {
    const r = await reportsRepo.summary(tenantId, '2000-01-01T00:00:00Z', '2000-01-02T00:00:00Z');
    assert.equal(r.orders, 0);
    assert.equal(r.total, 0);
    assert.equal(r.averageOrder, 0, 'must not divide by zero');
    assert.deepEqual(r.bySource, []);
  });

  await check('the CSV of a live report is well-formed', async () => {
    const from = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const to   = new Date(Date.now() + 86_400_000).toISOString();
    const csv  = toCsv(await reportsRepo.summary(tenantId, from, to));
    assert.ok(!csv.includes('undefined'));
    assert.ok(!csv.includes('NaN'));
    assert.ok(!csv.includes('[object Object]'));
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
