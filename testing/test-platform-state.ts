// The Redis → Postgres source-of-truth cutover.
//
//   npx tsx testing/test-platform-state.ts
//
// Platform state (tenant configs, adapter credentials, logins, audit) used to
// live in Redis, with Postgres written fire-and-forget behind it. The direction
// is now reversed. Two classes of regression are cheap to introduce and
// expensive to notice, so both are pinned here:
//
//   1. A write that reaches only the cache but reports success. That is silent
//      data loss — the user is told their config saved, and it evaporates when
//      the key expires. mustWrite() must throw; only bestEffort() may not.
//
//   2. A read path quietly reverted to Redis-only. Nothing fails when that
//      happens: it works perfectly until a key expires, which is the same
//      failure mode that made the original bug survive for so long.
//
// The second class is checked by reading the source, in the same spirit as the
// "server.ts actually wires these gates" section of test-guest-isolation.ts. It
// is a blunt instrument, but the alternative is no coverage at all until a
// tenant's cache entry expires in production.
//
// No database, no network, no JWT_SECRET.

import assert from 'node:assert';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mustWrite, bestEffort, REVOKED_PASSWORD_HASH } from '../src/lib/repo.js';

let passed = 0, failed = 0;
const section = (n: string) => console.log(n);
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n      ${(err as Error).message}`); failed++; }
}

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// Comments in this codebase describe what the code USED to do, at length. A
// source check that greps the raw file matches its own explanation of the bug it
// is guarding against, so strip comments before asserting on behaviour.
const code = (p: string) => src(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

// Capture console output so the logging contract can be asserted without the
// suite's own output being polluted by the failures it deliberately provokes.
function captureErrors<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  return fn()
    .then(result => ({ result, logs }))
    .finally(() => { console.error = original; });
}

// ── 1. Write helpers ─────────────────────────────────────────────────────────

section('a write that IS the record must fail loudly');

await check('mustWrite propagates the failure to its caller', async () => {
  const { logs } = await captureErrors(async () => {
    await assert.rejects(
      () => mustWrite('tenant_configs.upsert', Promise.reject(new Error('PGRST204'))),
      /tenant_configs\.upsert/,
      'mustWrite must throw so the route can answer 5xx',
    );
  });
  assert.ok(logs.some(l => l.includes('PGRST204')), 'the underlying error must be logged');
});

await check('mustWrite names the table, not just the driver message', async () => {
  await captureErrors(async () => {
    await assert.rejects(
      () => mustWrite('adapter_credentials.upsert', Promise.reject(new Error('boom'))),
      (err: Error) => err.message.includes('adapter_credentials.upsert') && err.message.includes('boom'),
    );
  });
});

await check('mustWrite resolves quietly on success', async () => {
  await mustWrite('tenants.upsert', Promise.resolve('ok'));
});

section('a genuine side-effect must not fail its caller — but must be visible');

await check('bestEffort swallows the failure', async () => {
  await captureErrors(() => bestEffort('audit_log', Promise.reject(new Error('column missing'))));
});

await check('bestEffort logs unconditionally, not only in development', async () => {
  // The regression this pins: dualWrite() logged at console.debug behind
  // NODE_ENV === 'development', so every audit_log insert failed in production
  // for the life of the feature with no trace anywhere.
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const { logs } = await captureErrors(
      () => bestEffort('audit_log', Promise.reject(new Error('column missing'))),
    );
    assert.ok(logs.length > 0, 'a failed best-effort write must still be logged in production');
    assert.ok(logs.some(l => l.includes('audit_log')), 'the log must name what failed');
  } finally {
    process.env.NODE_ENV = previous;
  }
});

// ── 2. Revoked logins ────────────────────────────────────────────────────────

section('removing a staff member actually revokes their login');

await check('the revocation sentinel cannot collide with a real password hash', async () => {
  // Login compares a sha256 hex digest against the stored hash. If the sentinel
  // were ever a valid digest, some password would authenticate a revoked account.
  assert.ok(!/^[0-9a-f]{64}$/i.test(REVOKED_PASSWORD_HASH),
    'the sentinel must not be a valid sha256 digest');
  for (const guess of ['', 'password', 'admin', REVOKED_PASSWORD_HASH]) {
    const digest = crypto.createHash('sha256').update(guess).digest('hex');
    assert.notStrictEqual(digest, REVOKED_PASSWORD_HASH);
  }
});

await check('removal revokes in Postgres, not only in Redis', async () => {
  const s = src('server.ts');
  const route = s.slice(s.indexOf("app.delete('/api/admin/staff/:email'"));
  const body  = route.slice(0, route.indexOf('app.'  , 10));
  assert.ok(body.includes('usersRepo.revokeLogin'),
    'deleting the Redis record no longer revokes anything — login reads platform_users');
});

// ── 3. The read paths did not revert ─────────────────────────────────────────

section('reads resolve through Postgres, not Redis alone');

await check('attachAdapter loads config and credentials via platformState', async () => {
  const s = src('middleware/tenant.ts');
  assert.ok(s.includes('readTenantConfig'), 'config must fall through to Postgres');
  assert.ok(s.includes('readCredentials'),  'credentials must fall through to Postgres');
  assert.ok(!s.includes('redisKey.tenantConfig'),
    'a direct cache read here reintroduces "expired key = tenant not found"');
});

await check('login reads platform_users, not the legacy Redis record', async () => {
  const s = src('server.ts');
  assert.ok(s.includes('findUserByEmail(loginId)'), 'login must go through platformState');
  assert.ok(!s.includes('`user:email:${loginId.toLowerCase()}`'),
    'login must not read the legacy Redis key directly');
});

await check('no route reads tenant config straight from the cache', async () => {
  // warmTenantConfig/invalidateTenantConfig in platformState.ts are the only
  // places that may touch this key, because they are the cache.
  for (const file of ['server.ts', 'routes/pos.ts', 'routes/guest.ts', 'middleware/tenant.ts']) {
    assert.ok(!src(file).includes('redisKey.tenantConfig'),
      `${file} reads or writes the config cache directly — go through platformState`);
  }
});

await check('a diner scanning a QR does not depend on a warm cache', async () => {
  // routes/guest.ts threw outright on a cache miss, so an expired config key
  // took every table in the restaurant offline at once.
  assert.ok(src('routes/guest.ts').includes('readTenantConfig'),
    'the guest gate must fall through to Postgres like every other read');
});

await check('credential reads fall through to Postgres everywhere', async () => {
  assert.ok(!src('server.ts').includes('redisKey.credentialsKey'),
    'a direct credential cache read silently degrades a tenant integration to unconfigured');
});

await check('config writes go to Postgres first and are allowed to fail', async () => {
  const s = src('server.ts');
  assert.ok(s.includes('await writeTenantConfig('),
    'save-config must await the durable write');
  assert.ok(!/void\s+dualWrite/.test(s), 'no fire-and-forget platform writes may remain');
  assert.ok(!s.includes('dualWrite'), 'dualWrite is gone — mustWrite or bestEffort');
});

await check('registration persists before it reports success', async () => {
  const s = src('server.ts');
  const route = s.slice(s.indexOf("app.post('/api/auth/register'"));
  const body  = route.slice(0, route.indexOf('app.post(', 10));
  const persistAt = body.indexOf('await createUser(');
  const respondAt = body.indexOf('res.status(201)');
  assert.ok(persistAt > -1, 'registration must create the user in Postgres');
  assert.ok(respondAt > persistAt,
    'a 201 before the durable write means a signup that can silently not exist');
});

// ── 4. Payments are durable ──────────────────────────────────────────────────

section('card payments outlive their cache entry');

await check('the payment store writes Postgres and caches second', async () => {
  const s = src('src/lib/paymentStore.ts');
  const write   = s.indexOf('paymentsRepo.record');
  const caching = s.indexOf('await cache(txn)');
  assert.ok(write > -1 && caching > write,
    'the durable write must precede the cache write, so the cache can never hold '
    + 'a payment Postgres never accepted');
});

await check('lookups fall back to payment_transactions', async () => {
  const s = src('src/lib/paymentStore.ts');
  assert.ok(s.includes('paymentsRepo.findByRef'),
    'an expired cache entry must not make a real payment unresolvable');
});

await check('no payment path writes only to Redis', async () => {
  for (const file of ['server.ts', 'src/lib/paddleOrderPayment.ts']) {
    const s = src(file);
    assert.ok(!s.includes('redisKey.payment('),
      `${file} writes the payment cache directly — go through paymentStore`);
  }
});

await check('the durable table is covered by the boot-time schema check', async () => {
  // audit_log silently recorded nothing for its whole life because its columns
  // drifted and no check caught it. payment_transactions is now load-bearing in
  // the same way.
  assert.ok(src('src/lib/supabaseAdmin.ts').includes('payment_transactions:'),
    'payment_transactions must be in EXPECTED_COLUMNS');
});

await check('paddle is an accepted provider on the durable table', async () => {
  // migrations/002_payments.sql predates Paddle and its check constraint would
  // reject every row the live provider writes.
  const sql = src('migrations/017_payment_tx_paddle.sql');
  assert.ok(sql.includes("'paddle'"), 'the provider constraint must allow paddle');
});

// ── 5. Menu ids ──────────────────────────────────────────────────────────────

section('menu inserts rely on a database default that had to be created');

await check('no caller hand-allocates a menu id', async () => {
  // categories/sub_categories/dishes are int NOT NULL with no default until
  // migration 019. Once it exists, an explicit id does NOT advance the sequence,
  // so a hand-allocated id walks it toward a collision that surfaces in the
  // FastAPI service, not here.
  for (const file of ['src/lib/posMenuWrite.ts', 'scripts/backfill-pos.ts']) {
    const body = src(file);
    assert.ok(!/\bid:\s*(dishId|catId|subId|newCatId|newSubId)/.test(body),
      `${file} supplies an explicit menu id — let the sequence assign it`);
  }
  assert.ok(!src('scripts/backfill-pos.ts').includes('async function nextId'),
    'the max(id)+1 allocator must not come back');
});

await check('the sequences migration exists and covers all five tables', async () => {
  const sql = src('migrations/019_menu_id_sequences.sql');
  for (const t of ['categories', 'sub_categories', 'dishes', 'dish_options', 'dish_sub_options']) {
    assert.ok(sql.includes(`'${t}'`), `migration 019 must cover ${t}`);
  }
  assert.ok(sql.includes('setval'), 'each sequence must be set past the existing max(id)');
});

// ── 6. One order ledger ──────────────────────────────────────────────────────

section('every adapter writes orders to our own ledger');

await check('the managed adapter does not submit orders upstream', async () => {
  // ManagedBackendAdapter used to POST /api/v1/agent/submit-order, which made
  // `managed` tenants' orders the one channel that bypassed the ledger. That is
  // how orders.source reported every voice order as 'kiosk' and order_number
  // stayed null on most rows.
  //
  // Scoped to this adapter deliberately. CustomApiAdapter and WebhookAdapter
  // also send orders outward, and must keep doing so: a `custom_api` tenant owns
  // their menu and orders in their own system and we are a client of it. The
  // ledger rule is about OUR data — `managed` pointed at the same Postgres this
  // app owns, which is what made it a split rather than an integration.
  assert.ok(!/submit-order/.test(code('adapter/ManagedBackendAdapter.ts')),
    'ManagedBackendAdapter still submits orders upstream — non-negotiable #1');
});

await check('the managed adapter writes and reads orders in the same place', async () => {
  const body = code('adapter/ManagedBackendAdapter.ts');
  assert.ok(body.includes('ordersRepo.create'), 'orders must be written to our ledger');
  assert.ok(body.includes('ordersRepo.list'),
    'reading orders upstream while writing them here shows the till an empty order book');
});

await check('the upstream cart is cleared only after the sale is committed', async () => {
  const body   = code('adapter/ManagedBackendAdapter.ts');
  const create = body.indexOf('ordersRepo.create');
  const clear  = body.indexOf('this.clearCart(params.sessionId)');
  assert.ok(create > -1 && clear > create,
    'clearing the cart before the write loses the basket when the write fails');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
