// Receipt and kitchen-ticket byte assembly.
//
//   npx tsx testing/test-escpos.ts
//
// Pure — no printer. Worth pinning down here because the alternative way to
// find a column-alignment bug is to print a hundred crooked receipts, and the
// alternative way to find an encoding bug is a customer holding a receipt
// covered in random glyphs.

import assert from 'node:assert';
import {
  CMD, sanitise, ReceiptBuilder, buildReceipt, buildKitchenTicket,
} from '../src/lib/escpos.js';

let passed = 0, failed = 0;
const section = (n: string) => console.log(n);
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${(err as Error).message}`); failed++; }
}

const asText = (b: Buffer) => b.toString('latin1');
/**
 * The printable lines, with control sequences stripped.
 *
 * Each sequence's parameter count has to be exact. An earlier version treated
 * the parameter as optional (`.?`), which ate the first character of real text
 * after ESC @ — init takes NO parameter — and made every width assertion below
 * fail by one. That looked precisely like an off-by-one in the builder; it was
 * a bug in this helper.
 */
function lines(b: Buffer): string[] {
  return asText(b)
    /* eslint-disable no-control-regex */
    .replace(/\x1b@/g,      '')   // ESC @        init, no parameter
    .replace(/\x1b[aEd]./g, '')   // ESC a|E|d n  one parameter
    .replace(/\x1d!./g,     '')   // GS  ! n
    .replace(/\x1dV../g,    '')   // GS  V m n
    .replace(/\x1bp.../g,   '')   // ESC p m t1 t2
    /* eslint-enable no-control-regex */
    .split('\n');
}

section('text sanitising');

check('plain ASCII is untouched', () => {
  assert.equal(sanitise('Chicken Karahi x2'), 'Chicken Karahi x2');
});

check('typographic characters are transliterated', () => {
  // These arrive constantly from copy-pasted menu text.
  assert.equal(sanitise('Karahi — “special”'), 'Karahi - "special"');
  assert.equal(sanitise('Pulao × 2'), 'Pulao x 2');
  assert.equal(sanitise("it's…"), "it's...");
});

check('unrenderable characters are dropped, not mangled', () => {
  // A printer fed a byte it cannot render prints a random glyph, and a receipt
  // speckled with garbage reads as broken software.
  assert.equal(sanitise('Biryani بریانی'), 'Biryani ');
  assert.equal(sanitise('Pizza 🍕 slice'), 'Pizza  slice');
});

check('newlines survive', () => {
  assert.equal(sanitise('a\nb'), 'a\nb');
});

check('sanitising is applied by the builder, not just available', () => {
  const b = new ReceiptBuilder(32).line('Karahi — بریانی').build();
  const t = asText(b);
  assert.ok(t.includes('Karahi -'), 'em dash should be transliterated');
  assert.ok(!/[؀-ۿ]/.test(t), 'Urdu must not reach the printer');
});

section('layout');

check('a row right-aligns its value to the paper width', () => {
  const out = lines(new ReceiptBuilder(32).row('Subtotal', 'PKR 1500.00').build());
  const row = out.find(l => l.includes('Subtotal'))!;
  assert.equal(row.length, 32, `row should fill the width exactly, got ${row.length}`);
  assert.ok(row.endsWith('PKR 1500.00'), 'the value must sit hard against the right edge');
});

check('a long name is truncated but the price never is', () => {
  // A clipped name is still recognisable; a price missing a digit is a wrong
  // number on a document the customer keeps.
  const out = lines(new ReceiptBuilder(32)
    .row('Special Chicken Karahi With Extra Everything', 'PKR 2500.00').build());
  const row = out[0];
  assert.equal(row.length, 32);
  assert.ok(row.endsWith('PKR 2500.00'), 'the full price must survive');
});

check('rows are consistent across paper widths', () => {
  for (const w of [32, 42, 48]) {
    const row = lines(new ReceiptBuilder(w).row('Total', '100.00').build())[0];
    assert.equal(row.length, w, `width ${w} produced a ${row.length}-char row`);
  }
});

check('a rule spans the full width', () => {
  assert.equal(lines(new ReceiptBuilder(48).rule().build())[0].length, 48);
});

section('customer receipt');

const receipt = buildReceipt({
  restaurantName: 'Savour Foods',
  addressLines:   ['Blue Area, Islamabad'],
  orderNumber:    1042,
  orderType:      'dine_in',
  tableLabel:     '6',
  placedAt:       '2026-08-23T12:00:00Z',
  currency:       'PKR',
  lines: [
    { name: 'Chicken Karahi', quantity: 2, total: 1500, modifiers: ['leg piece'], notes: 'extra spicy' },
    { name: 'Naan',           quantity: 4, total: 200 },
  ],
  subtotal: 1700, discount: 200, serviceCharge: 150, tax: 247.5, total: 1897.5,
  payments: [{ method: 'cash', amount: 2000, change: 102.5 }],
});

check('starts with the printer init sequence', () => {
  // Without INIT the printer inherits whatever state the last job left it in —
  // the classic symptom is every receipt printing double-width after one did.
  assert.ok(receipt.subarray(0, 2).equals(CMD.INIT));
});

check('ends by feeding past the tear bar and cutting', () => {
  const tail = receipt.subarray(receipt.length - CMD.CUT.length);
  assert.ok(tail.equals(CMD.CUT), 'must end with a cut');
  assert.ok(asText(receipt).includes(asText(CMD.FEED(4))), 'and feed first, or the cut lands mid-text');
});

check('carries the order details a customer needs', () => {
  const t = asText(receipt);
  for (const s of ['Savour Foods', '#1042', 'dine in', 'Chicken Karahi', 'Naan']) {
    assert.ok(t.includes(s), `receipt should mention "${s}"`);
  }
});

check('shows every money line, and the total', () => {
  const t = asText(receipt);
  for (const s of ['Subtotal', 'Discount', 'Service charge', 'Tax', 'TOTAL', '1897.50']) {
    assert.ok(t.includes(s), `receipt should show "${s}"`);
  }
});

check('shows the tender and the change', () => {
  const t = asText(receipt);
  assert.ok(t.includes('CASH'), 'the method');
  assert.ok(t.includes('102.50'), 'and the change actually handed back');
});

check('zero-value money lines are omitted, not printed as 0.00', () => {
  const plain = asText(buildReceipt({
    restaurantName: 'X', orderNumber: 1, orderType: 'takeaway',
    placedAt: '2026-08-23T12:00:00Z', currency: 'PKR',
    lines: [{ name: 'Tea', quantity: 1, total: 100 }],
    subtotal: 100, discount: 0, serviceCharge: 0, tax: 0, total: 100,
  }));
  assert.ok(!plain.includes('Discount'),       'a zero discount is noise');
  assert.ok(!plain.includes('Service charge'), 'so is a zero service charge');
  assert.ok(plain.includes('TOTAL'));
});

check('modifiers and notes appear under their line', () => {
  const t = asText(receipt);
  assert.ok(t.includes('+ leg piece'));
  assert.ok(t.includes('* extra spicy'));
});

section('kitchen ticket');

const ticket = buildKitchenTicket({
  orderNumber: 1042,
  orderType:   'dine_in',
  tableLabel:  '6',
  placedAt:    '2026-08-23T12:00:00Z',
  station:     'Grill',
  lines: [{ name: 'Chicken Karahi', quantity: 2, modifiers: ['leg piece'], notes: 'no onions', seat: 3 }],
});

check('the order number is double height', () => {
  // A cook reads this at arm's length in a hot room.
  assert.ok(asText(ticket).includes(asText(CMD.DOUBLE_ON)));
  assert.ok(asText(ticket).includes('#1042'));
});

check('never shows money — it is not actionable in a kitchen', () => {
  const t = asText(ticket);
  for (const s of ['PKR', 'TOTAL', 'Subtotal', '1500']) {
    assert.ok(!t.includes(s), `a kitchen ticket must not contain "${s}"`);
  }
});

check('leads with quantity, and carries station, table and seat', () => {
  const t = asText(ticket);
  assert.ok(t.includes('2 x Chicken Karahi'), 'quantity first');
  assert.ok(t.includes('Grill'));
  assert.ok(t.includes('TABLE 6'));
  assert.ok(t.includes('seat 3'));
});

check('notes are emphasised — missing one sends the plate back', () => {
  const t = asText(ticket);
  assert.ok(t.includes('** no onions'));
  const noteIdx = t.indexOf('no onions');
  const boldIdx = t.lastIndexOf(asText(CMD.BOLD_ON), noteIdx);
  assert.ok(boldIdx > -1 && noteIdx - boldIdx < 40, 'the note should be inside a bold run');
});

check('a reprint says so, loudly', () => {
  // The cost of a cook missing this is a duplicate dish.
  const rp = asText(buildKitchenTicket({
    orderNumber: 7, orderType: 'takeaway', placedAt: '2026-08-23T12:00:00Z',
    lines: [{ name: 'Tea', quantity: 1 }], reprint: true,
  }));
  assert.ok(rp.includes('REPRINT'));
  assert.ok(rp.includes('MAY ALREADY BE MADE'));
});

check('a normal ticket carries no reprint warning', () => {
  assert.ok(!asText(ticket).includes('REPRINT'));
});

section('drawer');

check('the kick is a pin-2 pulse, and is opt-in', () => {
  assert.ok(!asText(receipt).includes(asText(CMD.DRAWER_KICK)),
    'a receipt must not open the drawer by itself');
  const withKick = new ReceiptBuilder(48).kickDrawer().build();
  assert.ok(asText(withKick).includes(asText(CMD.DRAWER_KICK)));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
