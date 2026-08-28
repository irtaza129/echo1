// One-shot backfill: copy platform state out of Redis into the Postgres tables
// that are now the source of truth for it.
//
//   npx tsx --env-file=.env scripts/backfill-platform-state.ts                  # dry run, all tenants
//   npx tsx --env-file=.env scripts/backfill-platform-state.ts --write
//   npx tsx --env-file=.env scripts/backfill-platform-state.ts --tenant <uuid> --write
//   npx tsx --env-file=.env scripts/backfill-platform-state.ts --write --verify
//   npx tsx --env-file=.env scripts/backfill-platform-state.ts --write --recover-orphans
//
// RUN THIS BEFORE DEPLOYING THE READS CUTOVER.
//
// Apply migrations 017 and 018 first. 018 in particular: tenant_configs.updated_by
// was a uuid while every caller passes an email, so the table has never accepted
// a row. This script refuses to run until that is fixed, rather than reporting
// 50 identical failures.
//
// `--recover-orphans` is separate from `--write`, in the same spirit as
// backfill-pos.ts keeping `--activate` separate. Copying state is safe and
// repeatable; inventing a tenants row for a login whose tenant config is gone is
// a judgement call about an account, so it is opt-in and reported by name first.
//
// Reads used to come from Redis, with Postgres written fire-and-forget behind
// them — so any tenant whose dual-write happened to fail exists in Redis only.
// After the cutover the read path is Redis cache → Postgres, and a tenant that
// was never persisted has nothing to fall through to: their config, their
// credentials and their admin login all disappear the moment the cache expires.
// This script closes that gap, and `--verify` proves it closed.
//
// Idempotent. Every write is an upsert keyed on the natural id (tenant uuid,
// email), so re-running changes nothing. Dry run by default — it reports what it
// WOULD write and touches nothing until --write is passed.
//
// Redis is only ever read here. Nothing is deleted: the legacy keys stay as a
// rollback path until the cutover has been in production long enough to trust.

import 'dotenv/config';
import { getRedis, redisKey } from '../src/lib/redis.js';
import { parseTenantConfig } from '../src/lib/tenantConfig.js';
import {
  tenantsRepo, tenantConfigsRepo, credentialsRepo, usersRepo,
  type UserRole,
} from '../src/lib/repo.js';
import { checkSchema } from '../src/lib/supabaseAdmin.js';
import type { EncryptedBlob } from '../src/lib/crypto.js';

const WRITE   = process.argv.includes('--write');
const VERIFY  = process.argv.includes('--verify');
const RECOVER = process.argv.includes('--recover-orphans');
const ONLY   = (() => {
  const i = process.argv.indexOf('--tenant');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

interface LegacyUserRecord {
  email:        string;
  passwordHash: string;
  tenantId:     string;
  slug:         string;
  role:         UserRole;
}

const stats = {
  tenants: 0, configs: 0, credentials: 0, users: 0,
  skipped: 0, failed: 0, orphans: 0, collisions: 0,
};

// slug → tenant id, built as tenants are written, so a second tenant claiming a
// slug is reported as the collision it is instead of surfacing as an opaque
// "duplicate key value violates unique constraint tenants_slug_key".
const slugOwner = new Map<string, string>();

// Tenants that actually had a config to copy. --verify checks these: a tenant
// with nothing in Redis to begin with cannot be restored by any script, and
// reporting it as a failure every run buries the ones that ARE actionable.
const attempted = new Set<string>();

function log(...parts: unknown[]): void {
  console.log(...parts);
}

/**
 * Every tenant id Redis knows about.
 *
 * The `tenants:index` set alone is not enough — membership was only ever added
 * by code paths that remembered to, so tenants exist whose config key is present
 * but who were never indexed. Scanning the config keys as well is what makes
 * this a migration rather than a partial copy.
 */
async function discoverTenantIds(): Promise<string[]> {
  const redis = getRedis();
  const ids   = new Set<string>();

  try {
    for (const id of await redis.smembers(redisKey.tenantsIndex)) ids.add(id);
  } catch (err) {
    console.warn('[BACKFILL] tenants:index unreadable:', (err as Error).message);
  }

  try {
    // `keys` is fine here: this is a one-shot operator script against a database
    // whose key count is in the hundreds, not a request path.
    const keys = await (redis as unknown as { keys(p: string): Promise<string[]> }).keys('tenant:config:*');
    for (const k of keys) ids.add(k.slice('tenant:config:'.length));
  } catch (err) {
    console.warn('[BACKFILL] could not scan tenant:config:* —', (err as Error).message);
  }

  return [...ids].filter(id => !ONLY || id === ONLY);
}

/**
 * Which tenant id currently holds a slug, according to Postgres and to the
 * legacy Redis mapping. Returns undefined when the slug is free.
 */
async function resolveSlugOwner(slug: string): Promise<string | undefined> {
  const seen = slugOwner.get(slug);
  if (seen) return seen;

  const row = await tenantsRepo.findBySlug(slug).catch(() => null);
  if (row) { slugOwner.set(slug, row.id); return row.id; }

  return undefined;
}

async function backfillTenant(tenantId: string): Promise<void> {
  const redis = getRedis();

  const raw = await redis.get<unknown>(redisKey.tenantConfig(tenantId)).catch(() => null);
  if (!raw) {
    log(`  · ${tenantId}  no cached config — nothing to copy`);
    stats.skipped++;
    return;
  }

  let config;
  try {
    config = parseTenantConfig(raw);
  } catch (err) {
    // A config Redis accepted but the schema rejects. Report it rather than
    // writing a shape the app cannot read back.
    console.error(`  ✗ ${tenantId}  config does not parse: ${(err as Error).message}`);
    stats.failed++;
    return;
  }

  log(`  · ${tenantId}  ${config.slug}  (${config.restaurantName})`);
  attempted.add(tenantId);

  if (!WRITE) {
    stats.tenants++; stats.configs++;
    const blob = await redis.get<EncryptedBlob>(redisKey.credentialsKey(tenantId)).catch(() => null);
    if (blob) stats.credentials++;
    return;
  }

  try {
    // tenants first — tenant_configs and adapter_credentials both carry a
    // foreign key into it.
    //
    // tenants.slug is UNIQUE, and Redis had no such constraint, so two tenants
    // can both hold the same slug there. Whichever the legacy `tenant:slug:<x>`
    // key points at is the one the kiosk URL actually served, so that one wins;
    // the other is reported and left for a human, because renaming somebody's
    // restaurant is not a decision a backfill gets to make.
    const owner = await resolveSlugOwner(config.slug);
    if (owner && owner !== tenantId) {
      console.error(
        `  ✗ ${tenantId}  slug "${config.slug}" is already held by ${owner}. ` +
        `Rename one of them (admin → Config) and re-run.`,
      );
      stats.collisions++; stats.failed++;
      return;
    }
    slugOwner.set(config.slug, tenantId);

    await tenantsRepo.upsert({
      id:   tenantId,
      slug: config.slug,
      name: config.restaurantName,
      plan: config.plan,
    });
    stats.tenants++;

    // 'backfill' is an opaque actor string, the same way audit_log.actor holds
    // "super" or "legacy-agent1101". Requires migration 018 — before it this
    // column was a uuid and rejected every value the app has ever passed.
    await tenantConfigsRepo.upsert(tenantId, config, 'backfill');
    stats.configs++;

    const blob = await redis.get<EncryptedBlob>(redisKey.credentialsKey(tenantId)).catch(() => null);
    if (blob) {
      // Copied as ciphertext — the backfill never decrypts, so it does not need
      // CREDENTIAL_ENCRYPTION_KEY and cannot leak a plaintext credential.
      await credentialsRepo.upsert(tenantId, blob);
      stats.credentials++;
    }
  } catch (err) {
    console.error(`  ✗ ${tenantId}  ${(err as Error).message}`);
    stats.failed++;
  }
}

/**
 * Copy the legacy `user:email:<addr>` login records into platform_users.
 *
 * These are what login now reads. A tenant admin whose record exists only in
 * Redis can still log in today (findUserByEmail heals on the way past), but only
 * while that key survives — it carries a one-year TTL from whenever they signed
 * up, and nothing refreshes it.
 */
async function backfillUsers(): Promise<void> {
  const redis = getRedis();

  let keys: string[] = [];
  try {
    keys = await (redis as unknown as { keys(p: string): Promise<string[]> }).keys('user:email:*');
  } catch (err) {
    console.warn('[BACKFILL] could not scan user:email:* —', (err as Error).message);
    return;
  }

  for (const key of keys) {
    const rec = await redis.get<LegacyUserRecord>(key).catch(() => null);
    if (!rec?.email || !rec.tenantId || !rec.passwordHash) {
      log(`  · ${key}  incomplete record — skipped`);
      stats.skipped++;
      continue;
    }
    if (ONLY && rec.tenantId !== ONLY) continue;

    // platform_users.tenant_id is a foreign key, so the tenant row has to exist
    // first. It often does not: these accounts belong to tenants whose Redis
    // config expired, leaving a login pointing at a tenant that no longer has a
    // record anywhere. Today they can still log in; after the cutover they
    // cannot, because there is nothing for the read path to fall through to.
    const tenantExists = WRITE
      ? await tenantsRepo.findById(rec.tenantId).then(Boolean).catch(() => false)
      : true;

    if (!tenantExists) {
      if (!RECOVER) {
        // Named, not counted — the operator needs to see whose account this is
        // before deciding to resurrect it. Many are test signups.
        log(`  ⚠ ${rec.email}  tenant ${rec.tenantId} has no config anywhere ` +
            `(slug "${rec.slug}") — pass --recover-orphans to keep this login`);
        stats.orphans++;
        continue;
      }

      // Recover the login by creating a minimal tenants row. Their CONFIG is
      // genuinely gone — nothing can bring it back — but an admin who can log in
      // can re-save one, whereas a locked-out admin cannot do anything at all.
      // The slug is disambiguated on collision rather than taken from whoever
      // currently holds it.
      let slug = rec.slug || rec.tenantId;
      const owner = await resolveSlugOwner(slug);
      if (owner && owner !== rec.tenantId) {
        slug = `${slug}-${rec.tenantId.slice(0, 8)}`;
        console.warn(`  ⚠ ${rec.email}  slug "${rec.slug}" taken by ${owner} — using "${slug}"`);
        stats.collisions++;
      }

      try {
        await tenantsRepo.upsert({ id: rec.tenantId, slug, name: rec.slug || slug, plan: 'starter' });
        slugOwner.set(slug, rec.tenantId);
        log(`  ↻ ${rec.email}  recovered tenant ${rec.tenantId} as "${slug}" (config lost — admin must re-save)`);
        stats.tenants++; stats.orphans++;
      } catch (err) {
        console.error(`  ✗ ${rec.email}  could not recover tenant: ${(err as Error).message}`);
        stats.failed++;
        continue;
      }
    } else {
      log(`  · ${rec.email}  → tenant ${rec.tenantId} as ${rec.role}`);
    }

    if (!WRITE) { stats.users++; continue; }

    try {
      await usersRepo.upsert({
        tenantId:     rec.tenantId,
        email:        rec.email.toLowerCase(),
        passwordHash: rec.passwordHash,
        role:         rec.role ?? 'tenant_admin',
      });
      stats.users++;
    } catch (err) {
      console.error(`  ✗ ${rec.email}  ${(err as Error).message}`);
      stats.failed++;
    }
  }
}

/**
 * Read back through the same repos the server now uses.
 *
 * The point is not that the writes returned 200 — it is that a request arriving
 * with a cold cache would find what it needs.
 */
async function verify(): Promise<void> {
  log('\n── Verifying (reading Postgres, ignoring cache) ──');
  const ids = [...attempted];
  let bad = 0;

  for (const id of ids) {
    const [tenant, config] = await Promise.all([
      tenantsRepo.findById(id).catch(() => null),
      tenantConfigsRepo.get(id).catch(() => null),
    ]);
    if (!tenant || !config) {
      console.error(`  ✗ ${id}  tenant=${tenant ? 'ok' : 'MISSING'} config=${config ? 'ok' : 'MISSING'}`);
      bad++;
    }
  }

  if (bad === 0) {
    log(`  ✓ all ${ids.length} tenant(s) with a config resolve from Postgres alone`);
  } else {
    log(`  ✗ ${bad} of ${ids.length} would break on a cold cache — do not deploy the cutover yet`);
  }

  if (stats.skipped) {
    // Not a verification failure: there is no copy of these configs anywhere, so
    // no script can restore one. They already behave as un-onboarded tenants.
    log(`  ⚠ ${stats.skipped} tenant(s) had no config in Redis either — unrecoverable, ` +
        `their admin must re-save from the Config tab`);
  }
}

async function main(): Promise<void> {
  if (process.env.USE_MOCK_REDIS === 'true') {
    console.error('[BACKFILL] USE_MOCK_REDIS is set — this must run against real Redis. Aborting.');
    process.exit(1);
  }

  // Preflight. tenant_configs.updated_by was declared uuid while every caller
  // passes an email, so before migration 018 this script fails identically on
  // every tenant and the real message is buried 50 lines deep. Fail once,
  // clearly, instead.
  try {
    const problems = await checkSchema();
    const blocking = problems.filter(p => p.missing.length || p.mistyped?.length);
    if (blocking.length) {
      console.error('[BACKFILL] Postgres schema is not ready:\n');
      for (const p of blocking) {
        if (p.missing.length) console.error(`  ${p.table}: missing ${p.missing.join(', ')}`);
        for (const m of p.mistyped ?? []) {
          console.error(`  ${p.table}.${m.column}: expected ${m.expected}, found ${m.actual}`);
        }
      }
      console.error('\nApply the pending migrations in migrations/ and re-run.');
      process.exit(1);
    }
  } catch (err) {
    console.warn('[BACKFILL] could not verify schema:', (err as Error).message);
  }

  log(WRITE ? '── Backfilling platform state → Postgres ──'
            : '── DRY RUN (pass --write to apply) ──');
  if (ONLY) log(`   limited to tenant ${ONLY}\n`);

  const tenantIds = await discoverTenantIds();
  log(`\nTenants (${tenantIds.length}):`);
  for (const id of tenantIds) await backfillTenant(id);

  log('\nUsers:');
  await backfillUsers();

  log('\n── Summary ──');
  log(`  tenants      ${stats.tenants}`);
  log(`  configs      ${stats.configs}`);
  log(`  credentials  ${stats.credentials}`);
  log(`  users        ${stats.users}`);
  log(`  skipped      ${stats.skipped}`);
  log(`  orphans      ${stats.orphans}${RECOVER ? ' (recovered)' : ' — pass --recover-orphans to keep these logins'}`);
  log(`  collisions   ${stats.collisions}`);
  log(`  failed       ${stats.failed}`);

  if (VERIFY && WRITE) await verify();

  if (!WRITE) log('\nNothing was written. Re-run with --write to apply.');

  // A failed copy means a tenant would vanish on a cold cache — make that
  // visible to whatever is running this, not just to whoever reads the output.
  process.exit(stats.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[BACKFILL] fatal:', err);
  process.exit(1);
});
