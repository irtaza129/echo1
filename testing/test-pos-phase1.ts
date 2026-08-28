// Unit tests for the Phase 1 primitives: the POS event bus and staff PIN
// hashing. Run with:  npx tsx testing/test-pos-phase1.ts
//
// Same shape as test-payments.ts — bare tsx + node:assert, no test runner.

import assert from 'node:assert';
import { publish, subscribe, replaySince, listenerCount, type PosEvent } from '../src/lib/posEvents.js';
import { hashPin, verifyPin, isValidPinFormat, isWeakPin } from '../src/lib/pin.js';
import { normalisePermissions, NO_PERMISSIONS } from '../src/lib/staffRepo.js';

let passed = 0, failed = 0;

function section(name: string) { console.log(name); }
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${(err as Error).message}`); failed++; }
}

const T1 = '00000000-0000-4000-8000-0000000000a1';
const T2 = '00000000-0000-4000-8000-0000000000a2';

// ── Event bus ────────────────────────────────────────────────────────────────

section('pos event bus');

await check('a subscriber receives a published event', () => {
  const seen: PosEvent[] = [];
  const off = subscribe(T1, e => seen.push(e));
  publish(T1, 'order.created', { orderId: 'o1' });
  off();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'order.created');
  assert.equal(seen[0].data.orderId, 'o1');
});

await check('events are isolated per tenant', () => {
  const t1: PosEvent[] = [], t2: PosEvent[] = [];
  const off1 = subscribe(T1, e => t1.push(e));
  const off2 = subscribe(T2, e => t2.push(e));
  publish(T1, 'order.paid', { orderId: 'only-t1' });
  off1(); off2();
  assert.equal(t1.length, 1, 'tenant 1 should see its own event');
  assert.equal(t2.length, 0, 'tenant 2 must not see tenant 1 events');
});

await check('ids are monotonic within a tenant', () => {
  const seen: PosEvent[] = [];
  const off = subscribe(T1, e => seen.push(e));
  publish(T1, 'order.status', {});
  publish(T1, 'order.status', {});
  off();
  assert.equal(seen[1].id, seen[0].id + 1);
});

await check('unsubscribe actually detaches', () => {
  const seen: PosEvent[] = [];
  const off = subscribe(T1, e => seen.push(e));
  off();
  publish(T1, 'order.status', {});
  assert.equal(seen.length, 0);
  assert.equal(listenerCount(T1), 0, 'no listeners should remain');
});

await check('replay returns only events after Last-Event-ID', () => {
  const before = replaySince(T1, null);
  assert.equal(before.events.length, 0, 'a null cursor replays nothing');

  publish(T2, 'order.created', { n: 1 });
  publish(T2, 'order.created', { n: 2 });
  publish(T2, 'order.created', { n: 3 });

  const r = replaySince(T2, 1);
  assert.equal(r.gap, false);
  assert.deepEqual(r.events.map(e => e.data.n), [2, 3]);
});

await check('a cursor at the head replays nothing and reports no gap', () => {
  const head = replaySince(T2, null);
  assert.equal(head.gap, false);
  publish(T2, 'order.status', {});
  const all = replaySince(T2, 0);
  const last = all.events[all.events.length - 1].id;
  const r = replaySince(T2, last);
  assert.equal(r.events.length, 0);
  assert.equal(r.gap, false);
});

await check('a cursor ahead of the server reports a gap (server restarted)', () => {
  const r = replaySince(T2, 999_999);
  assert.equal(r.gap, true, 'client ahead of server must force a resync');
});

await check('publish never throws on a failing subscriber', () => {
  const off = subscribe(T1, () => { throw new Error('subscriber blew up'); });
  // EventEmitter rethrows synchronously; publish must contain it so a broken
  // terminal cannot fail the sale that triggered the event.
  assert.doesNotThrow(() => publish(T1, 'order.created', {}));
  off();
});

await check('a throwing subscriber does not starve the others', () => {
  // The real hazard: emit() runs listeners in order and lets an exception
  // propagate, so containing it only around the emit would abandon every
  // listener registered AFTER the broken one. One wedged terminal would
  // silently stop the rest of the floor receiving orders.
  const healthy: PosEvent[] = [];
  const offBad  = subscribe(T1, () => { throw new Error('terminal wedged'); });
  const offGood = subscribe(T1, e => healthy.push(e));

  publish(T1, 'order.created', { orderId: 'must-still-arrive' });

  offBad(); offGood();
  assert.equal(healthy.length, 1, 'the healthy subscriber must still receive the event');
  assert.equal(healthy[0].data.orderId, 'must-still-arrive');
});

await check('unsubscribing one subscriber leaves the others attached', () => {
  const a: PosEvent[] = [], b: PosEvent[] = [];
  const offA = subscribe(T1, e => a.push(e));
  const offB = subscribe(T1, e => b.push(e));
  offA();
  publish(T1, 'order.status', {});
  offB();
  assert.equal(a.length, 0, 'detached subscriber must receive nothing');
  assert.equal(b.length, 1, 'the remaining subscriber must still receive events');
});

// ── PIN hashing ──────────────────────────────────────────────────────────────

section('staff PIN hashing');

await check('a PIN verifies against its own hash', async () => {
  const h = await hashPin('4817');
  assert.equal(await verifyPin('4817', h), true);
});

await check('a wrong PIN does not verify', async () => {
  const h = await hashPin('4817');
  assert.equal(await verifyPin('4818', h), false);
});

await check('the same PIN hashes differently each time (per-PIN salt)', async () => {
  const a = await hashPin('4817');
  const b = await hashPin('4817');
  assert.notEqual(a, b, 'two staff with the same PIN must not share a hash');
  assert.equal(await verifyPin('4817', a), true);
  assert.equal(await verifyPin('4817', b), true);
});

await check('the stored format is self-describing scrypt', async () => {
  const h = await hashPin('4817');
  const parts = h.split('$');
  assert.equal(parts[0], 'scrypt');
  assert.equal(parts.length, 6, 'scrypt$N$r$p$salt$hash');
  assert.equal(Number(parts[1]) >= 16384, true, 'cost must not be weakened');
});

await check('a malformed stored hash reads as a wrong PIN, never a throw', async () => {
  assert.equal(await verifyPin('4817', 'garbage'), false);
  assert.equal(await verifyPin('4817', ''), false);
  assert.equal(await verifyPin('4817', 'scrypt$1$2$3$zz$zz'), false);
});

await check('cost parameters are read back from the stored hash', async () => {
  // A hash written with a lower cost must still verify, so raising N later
  // does not invalidate every existing PIN.
  const h = await hashPin('9271');
  const weakened = h.replace(/^scrypt\$\d+/, 'scrypt$16384');
  assert.equal(await verifyPin('9271', weakened), true);
});

section('PIN policy');

await check('format: 4 to 8 digits only', () => {
  assert.equal(isValidPinFormat('4817'), true);
  assert.equal(isValidPinFormat('48170000'), true);
  assert.equal(isValidPinFormat('481'), false, 'too short');
  assert.equal(isValidPinFormat('481700001'), false, 'too long');
  assert.equal(isValidPinFormat('48a7'), false, 'digits only');
  assert.equal(isValidPinFormat(''), false);
});

await check('obvious PINs are rejected', () => {
  for (const weak of ['0000', '1111', '1234', '4321', '2580', '3456', '87654']) {
    assert.equal(isWeakPin(weak), true, `${weak} should be rejected`);
  }
});

await check('a reasonable PIN is accepted', () => {
  for (const ok of ['4817', '9271', '5093', '73914']) {
    assert.equal(isWeakPin(ok), false, `${ok} should be allowed`);
  }
});

// ── Permissions ──────────────────────────────────────────────────────────────

section('POS permissions');

await check('an empty object grants nothing', () => {
  assert.deepEqual(normalisePermissions({}), NO_PERMISSIONS);
  assert.deepEqual(normalisePermissions(null), NO_PERMISSIONS);
  assert.deepEqual(normalisePermissions(undefined), NO_PERMISSIONS);
});

await check('only literal true grants a capability', () => {
  // A truthy-but-not-true value from a hand-edited jsonb column must not
  // silently become a privilege.
  const p = normalisePermissions({ can_void: 'yes', can_refund: 1, can_discount: true });
  assert.equal(p.can_void, false);
  assert.equal(p.can_refund, false);
  assert.equal(p.can_discount, true);
});

await check('max_discount_pct is clamped to 0..100', () => {
  assert.equal(normalisePermissions({ max_discount_pct: 150 }).max_discount_pct, 100);
  assert.equal(normalisePermissions({ max_discount_pct: -10 }).max_discount_pct, 0);
  assert.equal(normalisePermissions({ max_discount_pct: 'abc' }).max_discount_pct, 0);
  assert.equal(normalisePermissions({ max_discount_pct: 12.5 }).max_discount_pct, 12.5);
});

await check('unknown keys are dropped, not stored', () => {
  const p = normalisePermissions({ can_fly: true, can_void: true }) as Record<string, unknown>;
  assert.equal('can_fly' in p, false, 'an undesigned capability must not survive');
  assert.equal(p.can_void, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
