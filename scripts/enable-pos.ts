// Turn the POS (and optionally Reservations / QR / phone) on for one tenant.
//
//   npx tsx --env-file=.env scripts/enable-pos.ts --tenant <uuid>
//   npx tsx --env-file=.env scripts/enable-pos.ts --slug fassih
//   npx tsx --env-file=.env scripts/enable-pos.ts --slug fassih --native   # also switch to PosAdapter
//   npx tsx --env-file=.env scripts/enable-pos.ts --slug fassih --reservations
//   npx tsx --env-file=.env scripts/enable-pos.ts --slug fassih --qr
//   npx tsx --env-file=.env scripts/enable-pos.ts --slug fassih --phone --did '+923001234567'
//   npx tsx --env-file=.env scripts/enable-pos.ts --slug fassih --show     # read-only
//
// Why this exists
// ---------------
// /api/pos/* is gated by requireFeature('pos'), which reads
// TenantConfig.features.pos and fails closed. That default is correct — the POS
// is sold separately — but it means a brand-new install has no way to reach the
// till at all until someone flips the flag, and there is no admin UI for it yet.
//
// Redis is the PRIMARY store for tenant config (middleware/tenant.ts reads it
// first and only falls back to Postgres). So this writes Redis, mirrors to
// Postgres, and deletes the cache key last so the next request re-reads a
// config that is already correct in both places.
//
// --native additionally sets adapter.type = 'pos', which points menu, cart and
// orders at our own Postgres instead of the Render backend. That changes which
// code serves a live kiosk, so it is opt-in and separate from the feature flag.
// Copy the menu over FIRST with:
//   npx tsx scripts/backfill-pos.ts --tenant <uuid> --write

import 'dotenv/config';
import { getRedis, redisKey, TTL } from '../src/lib/redis.js';
import { parseTenantConfig, type TenantConfig } from '../src/lib/tenantConfig.js';
import { tenantConfigsRepo } from '../src/lib/repo.js';
import * as db from '../src/lib/supabaseAdmin.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (n: string) => process.argv.includes(`--${n}`);

async function resolveTenantId(): Promise<string> {
  const direct = arg('tenant');
  if (direct) return direct;

  const slug = arg('slug');
  if (!slug) {
    console.error('Pass --tenant <uuid> or --slug <slug>.');
    process.exit(1);
  }

  const row = await db.selectOne<{ id: string }>('tenants', { slug: `eq.${slug}`, select: 'id' });
  if (!row) { console.error(`No tenant with slug "${slug}".`); process.exit(1); }
  return row.id;
}

async function loadConfig(tenantId: string): Promise<TenantConfig> {
  // Redis first — it is what the middleware actually reads.
  try {
    const cached = await getRedis().get<unknown>(redisKey.tenantConfig(tenantId));
    if (cached) return parseTenantConfig(cached);
  } catch { /* fall through to Postgres */ }

  const row = await tenantConfigsRepo.get(tenantId);
  if (!row) {
    console.error(`No config found for tenant ${tenantId} in Redis or Postgres.`);
    console.error('Finish onboarding for this tenant first — there is nothing to enable yet.');
    process.exit(1);
  }
  return parseTenantConfig(row);
}

function describe(c: TenantConfig): void {
  console.log(`  slug             ${c.slug}`);
  console.log(`  adapter.type     ${c.adapter.type}`);
  console.log(`  features.pos     ${c.features.pos}`);
  console.log(`  features.res     ${c.features.reservations}`);
  console.log(`  channels.qr      ${c.channels?.qr?.enabled ?? false}`);
  console.log(`  channels.phone   ${c.channels?.phone?.enabled ?? false}`);
}

async function run(): Promise<void> {
  const tenantId = await resolveTenantId();
  const current  = await loadConfig(tenantId);

  console.log(`\nTenant ${tenantId}\n\nBefore:`);
  describe(current);

  if (has('show')) { console.log(''); return; }

  // This script's one unconditional action is features.pos = true — turning on
  // the Till. The Till always writes its orders to our own Postgres, so its
  // menu has to come from there too (see routes/pos.ts GET /menu). Setting
  // features.pos true while adapter.type stays 'managed'/'custom_api'/'webhook'
  // used to be allowed here, and it is exactly what broke a real tenant's
  // till: /api/menu kept returning the OLD adapter's menu shape, which has no
  // dish_id, so the Till's "which line is this tap for?" logic collided every
  // dish onto the same line. Refusing here, rather than silently producing
  // that split state, is cheaper than debugging it after the fact.
  const willBeNative = current.adapter.type === 'pos' || has('native');
  if (!willBeNative) {
    console.error(
      `This tenant's adapter.type is "${current.adapter.type}", not "pos".\n` +
      'Enabling the Till without --native would leave the till working but the ' +
      "menu it shows disconnected from what it actually sells — add --native, or " +
      'run scripts/backfill-pos.ts first if this tenant has an existing menu to bring across.',
    );
    process.exit(1);
  }

  const next: TenantConfig = {
    ...current,
    adapter: has('native') ? { ...current.adapter, type: 'pos' as const } : current.adapter,
    features: {
      ...current.features,
      pos:          true,
      reservations: has('reservations') ? true : current.features.reservations,
    },
    channels: {
      ...current.channels,
      ...(has('qr')
        ? { qr: { enabled: true, requirePin: true, orderMode: 'direct' as const, waiterCooldown: 60 } }
        : {}),
      ...(has('phone')
        ? {
            phone: {
              ...current.channels?.phone,
              enabled:          true,
              didNumber:        arg('did') ?? current.channels?.phone?.didNumber,
              greetingOverride: current.channels?.phone?.greetingOverride ?? '',
              transferTo:       arg('transfer-to') ?? current.channels?.phone?.transferTo ?? '',
              maxCallSeconds:   current.channels?.phone?.maxCallSeconds ?? 600,
            },
          }
        : {}),
    },
  };

  if (has('phone') && !arg('did') && !current.channels?.phone?.didNumber) {
    console.error('--phone needs --did <number> — without a DID no inbound call can be routed here.');
    process.exit(1);
  }

  // Validate before writing. A config that does not parse takes the tenant's
  // kiosk offline on the next request, and this script must never be the thing
  // that does that.
  const validated = parseTenantConfig(next);

  await getRedis().set(redisKey.tenantConfig(tenantId), validated, { ex: TTL.TENANT_CONFIG });
  try {
    await tenantConfigsRepo.upsert(tenantId, validated);
  } catch (err) {
    // Redis is primary, so the flag is already live. Report the mirror failure
    // rather than pretending the write was clean.
    console.warn('\n  (Postgres mirror failed — Redis is primary, so this is live anyway)');
    console.warn(`  ${err instanceof Error ? err.message : err}`);
  }

  console.log('\nAfter:');
  describe(validated);

  console.log('\nDone. Sign out and back in so the browser picks up a fresh token, then');
  console.log('open the kiosk and use the "Till →" button in the sidebar.');
  if (has('native')) {
    console.log('\nadapter.type is now "pos" — this tenant\'s menu and orders come from our');
    console.log('own Postgres. If the menu looks empty, copy it across with:');
    console.log(`  npx tsx --env-file=.env scripts/backfill-pos.ts --tenant ${tenantId} --write`);
  }
  console.log('');
}

run().catch(err => {
  console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
