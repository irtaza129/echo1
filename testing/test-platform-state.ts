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
import { normaliseFormat } from '../src/lib/supabaseAdmin.js';

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
//
// Line comments go FIRST, and the order is load-bearing: a line comment
// mentioning a route like /agent/<star> contains the characters that open a
// block comment, so stripping blocks first eats everything up to the next real
// */ — silently deleting live code and turning these checks green or red for
// the wrong reason. This cost a confusing failure once already.
const code = (p: string) => src(p)
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

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

// ── 7. The anon role has no grants ───────────────────────────────────────────

section('a public credential cannot reach this data');

await check('the revoke migration exists and is not a list that will rot', async () => {
  // The other service's .env reached a public repo. The leaked value is that
  // project's anon key, valid until 2036, and sixteen tables here still granted
  // it SELECT with RLS as the only filter — including adapter_credentials and
  // platform_users.
  const sql = src('migrations/020_revoke_anon.sql');
  assert.ok(/revoke all on table/.test(sql), 'tables must be revoked');
  assert.ok(/pg_tables/.test(sql) && /pg_views/.test(sql),
    'enumerate from the catalogue — a hand-written list misses the next table added');
  assert.ok(/alter default privileges[\s\S]*revoke all on tables\s+from anon/.test(sql),
    'without default privileges the next create table reopens the hole silently');
});

await check('the revoke cannot lock out the service this app actually uses', async () => {
  // Every query in this app goes through supabaseAdmin with the service-role
  // key, which holds its own grants and BYPASSRLS. If any code path ran as anon
  // this migration would take the platform offline, so the absence of a browser
  // -side Supabase client is part of the migration's safety argument.
  const sql = src('migrations/020_revoke_anon.sql');
  assert.ok(!/from\s+service_role/.test(sql), 'service_role must never be revoked');
  assert.ok(!/from\s+authenticated/.test(sql),
    'authenticated is out of scope — reaching it needs a Supabase Auth JWT we never issue');
  assert.ok(/notify pgrst/.test(sql),
    'PostgREST caches the schema; without the reload the API serves the old view');
});

await check('the revoke covers both roles that create objects in public', async () => {
  // 020's default-privileges clause applies only to objects created by the role
  // that ran it. pg_default_acl showed supabase_admin still granting anon
  // arwdDxtm on future tables — every privilege, not just SELECT — so 020 alone
  // closed half the hole and the other half would have reopened silently.
  const sql = src('migrations/021_revoke_anon_supabase_admin.sql');
  assert.ok(/for role supabase_admin/.test(sql), 'supabase_admin must be covered too');
  assert.ok(/insufficient_privilege/.test(sql),
    'altering another role may be refused — that must report, not abort the migration');
});

await check('the schema check does not invent mismatches from spelling', async () => {
  // It did. PostgREST reported payment_transactions.amount_paisa as `int64`
  // where EXPECTED_TYPES said `bigint`; the column was correct and the check
  // refused the platform-state backfill outright. A schema check that cries
  // wolf is worse than none — the next real mismatch reads as another quirk.
  assert.equal(normaliseFormat('int64'), normaliseFormat('bigint'));
  assert.equal(normaliseFormat('int8'),  normaliseFormat('bigint'));
  assert.equal(normaliseFormat('string'), normaliseFormat('text'));
  assert.equal(normaliseFormat('BIGINT'), 'bigint', 'comparison must be case-insensitive');
  // And it must still catch a genuine mismatch — the 018 bug was exactly this.
  assert.notEqual(normaliseFormat('uuid'), normaliseFormat('text'));
  assert.notEqual(normaliseFormat('numeric'), normaliseFormat('bigint'));
});

await check('a failed lookup is never reported as a wrong password', async () => {
  // selectOne returns null when the row is absent and THROWS when it could not
  // ask. `.catch(() => null)` collapsed those into one answer, and the login
  // route turns null into 401 — so an unreachable Postgres told every real user
  // their credentials were invalid, with nothing on screen to say otherwise.
  const body = code('src/lib/platformState.ts');
  assert.ok(/const row = await usersRepo\.findByEmail\(addr\);/.test(body),
    'the user lookup must be allowed to throw');
  assert.ok(!/usersRepo\.findByEmail\(addr\)\.catch/.test(body),
    'swallowing the failure is what made an outage look like a bad password');

  const server = code('server.ts');
  assert.ok(/\[AUTH\] user lookup failed[\s\S]{0,400}?res\.status\(503\)/.test(server),
    'a lookup failure must answer 503 (retryable), never 401');
});

section('the dry run reports what the real run will do');

await check('a dry run checks slug collisions, which need no writes', async () => {
  // It did not. backfillTenant returned early on !WRITE before reaching the
  // check, so a dry run reported 0 collisions and the real run hit one halfway
  // through production. A dry run that cannot see a blocking condition is worse
  // than none, because it is believed.
  const body = code('scripts/backfill-platform-state.ts');
  const collision = body.indexOf('resolveSlugOwner(config.slug)');
  const dryReturn = body.indexOf('if (!WRITE)');
  assert.ok(collision > -1 && dryReturn > -1,
    'both the collision check and the dry-run exit must still exist');
  assert.ok(collision < dryReturn,
    'the collision check must run BEFORE the dry-run exit, or it is invisible');
});

await check('a dry run reports orphaned logins', async () => {
  // `WRITE ? query : true` meant a dry run could not surface one. The gate was
  // not gratuitous — on a dry run the tenant rows do not exist yet, so querying
  // alone calls every login an orphan — so the fix consults what this run WOULD
  // have created, not a mode flag.
  const body = code('scripts/backfill-platform-state.ts');
  assert.ok(/attempted\.has\(rec\.tenantId\)/.test(body),
    'orphan detection must consult the tenants this run would create');
  assert.ok(!/const tenantExists = WRITE/.test(body),
    'orphan detection must not be gated on write mode');
});

await check('idempotent writes survive a transient stall', async () => {
  // ~180 sequential Postgres calls against a link that stalls intermittently.
  // One stall failed a tenant permanently: five failed, four of which succeeded
  // on a plain re-run. Safe here ONLY because every call is an upsert.
  const body = code('scripts/backfill-platform-state.ts');
  assert.ok(/async function withRetry/.test(body), 'upserts must retry');
  const client = code('src/lib/supabaseAdmin.ts');
  assert.ok(!/withRetry|retr(y|ies)/i.test(client),
    'retry must NOT live in the shared client — a retried insert can write twice');
});

await check('pruning proves a tenant empty in Postgres before deleting it', async () => {
  // The targets all LOOKED like test signups — kfc@gmail.com, mcdonalds@…,
  // howdy123. That is a guess. The script counts orders, dishes, payments and
  // logins for each and skips any target with a single row, because the cost of
  // being wrong is somebody's restaurant.
  const body = code('scripts/prune-stale-logins.ts');
  assert.ok(/DATA_TABLES/.test(body) && /orders/.test(body) && /payment_transactions/.test(body),
    'emptiness must be proved against the tables that hold real value');
  assert.ok(/refusing to delete blind/.test(body),
    'a failed count must abort, not be read as zero');
  assert.ok(/if \(!BACKUP\)/.test(body),
    'deletion must be impossible without a backup file');
  assert.ok(/Nothing was deleted\. Re-run with --write/.test(body),
    'dry run must be the default');
});

// ── 8. Outbound credentials to the upstream ──────────────────────────────────

section('calls to the upstream carry a signature, not just a claim');

await check('the upstream secret is not the one that signs staff and guest tokens', async () => {
  // src/lib/jwt.ts signs till logins and diner tokens. If the upstream held that
  // secret, anyone with access to its environment — a dashboard, a CI log, a
  // committed .env, which is exactly how its anon key became public — could mint
  // a super_admin till token.
  const body = code('src/lib/backendAuth.ts');
  assert.ok(body.includes('BACKEND_JWT_SECRET'), 'a dedicated secret is required');
  assert.ok(!/process\.env\.JWT_SECRET/.test(body),
    'the platform secret must never sign an outbound token');
});

await check('an unset secret degrades to today, rather than to a broken call', async () => {
  // The upstream never downgrades a present-but-invalid token to the tenant
  // header, so sending one speculatively breaks every call. Absent secret must
  // mean absent header.
  const body = code('src/lib/backendAuth.ts');
  assert.ok(/if \(!secret\)[\s\S]{0,240}return null/.test(body),
    'no secret must yield no token');
  assert.ok(/if \(token\) headers\.Authorization/.test(body),
    'the Authorization header must be conditional on having a token');
  assert.ok(/'X-Tenant-ID': tenantId/.test(body),
    'the tenant header stays — the upstream 403s on a mismatch and logs who has not migrated');
});

await check('every outbound upstream call goes through it', async () => {
  const server  = code('server.ts');
  const adapter = code('adapter/ManagedBackendAdapter.ts');
  assert.ok(!/headers:\s*\{\s*'X-Tenant-ID'/.test(server + adapter),
    'a hand-built tenant header is a call that will 401 when the upstream enforces auth');
  assert.ok(adapter.includes('backendHeaders(this.tenantId'),
    'the adapter must attach credentials to every call it makes');
});

await check('a half-written menu sync is retried, and a 4xx is not', async () => {
  // The upstream's menu upsert is five sequential statements; a timeout part way
  // through leaves categories written without dishes. It is idempotent, so a
  // retry heals it — but repeating a 401 only delays a failure that will not
  // change.
  const body = code('server.ts');
  assert.ok(body.includes('syncMenuUpstream'), 'both sync sites must share one path');
  assert.ok(/status >= 500/.test(body), 'only server-side failures may be retried');
});

// ── 9. One cart implementation ───────────────────────────────────────────────

section('the session cart lives in one place');

await check('both adapters share the cart, rather than each keeping one', async () => {
  // PosAdapter held the only cart until `managed` tenants needed one too.
  // Copying it would have given the product two stores with two lock strategies
  // and two TTLs for one concept — which is the shape of the upstream cart bug
  // this replaced, not a fix for it.
  for (const f of ['adapter/PosAdapter.ts', 'adapter/ManagedBackendAdapter.ts']) {
    assert.ok(code(f).includes("sessionCart.js"), `${f} must use the shared session cart`);
  }
  const cart = code('src/lib/sessionCart.ts');
  assert.ok(cart.includes('withCartLock'),
    'the shared cart must keep the lock — two add_item calls in one turn race');
});

await check('a resolved line is only kept locally when the upstream names it', async () => {
  // The gate is `dish_name`, and it exists so the two services can deploy in
  // either order. Defaulting it would put a guessed dish name on a receipt and
  // a kitchen ticket, which is worse than reading the cart back upstream.
  const body = code('adapter/ManagedBackendAdapter.ts');
  assert.ok(/res\.status !== 'ok' \|\| !res\.dish_name/.test(body),
    'toCartItem must refuse to build a line it cannot name');
  assert.ok(!/dish_name\s*\?\?/.test(body),
    'dish_name must never be defaulted — a guessed name reaches the customer');
});

await check('submitOrder reads its own cart, and never prices an empty one', async () => {
  const body     = code('adapter/ManagedBackendAdapter.ts');
  const submit   = body.indexOf('async submitOrder');
  const create   = body.indexOf('ordersRepo.create', submit);
  const snapshot = body.indexOf('snapshotCart', submit);
  const guard    = body.indexOf("return { error: 'Cart is empty' }", submit);

  assert.ok(snapshot > -1 && snapshot < create,
    'the local cart must be read before the order is written');
  assert.ok(guard > -1 && guard < create,
    'an empty basket must be refused, never written as a zero-line order');
});

await check('the adapter no longer reads a cart the upstream deleted', async () => {
  // remove-item, clear-cart and GET cart are 404 upstream. A 404 must never be
  // how an empty cart looks: getCart is what the diner's phone renders from,
  // and an exception there turns "nothing added yet" into a broken screen.
  const body = code('adapter/ManagedBackendAdapter.ts');
  for (const gone of ['agent/remove-item', 'agent/clear-cart', 'agent/cart/']) {
    assert.ok(!body.includes(gone), `${gone} is retired upstream and must not be called`);
  }
  assert.ok(!/upstreamCart|upstreamRemove/.test(body),
    'the changeover fallbacks are dead code once the upstream cart is gone');
});

await check('a resolved line that cannot be named is loud, not silently dropped', async () => {
  // The model has already told the customer the item was added. Dropping the
  // line quietly is a short order discovered at the counter.
  const body = code('adapter/ManagedBackendAdapter.ts');
  assert.ok(/console\.error\([\s\S]*?no dish_name/.test(body),
    'a nameless ok response must be logged at error, not swallowed');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
