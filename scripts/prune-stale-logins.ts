// Remove legacy Redis records that point at tenants which no longer exist.
//
//   npx tsx --env-file=.env scripts/prune-stale-logins.ts                 # report only
//   npx tsx --env-file=.env scripts/prune-stale-logins.ts --write
//   npx tsx --env-file=.env scripts/prune-stale-logins.ts --write --backup <file>
//
// WHAT THIS IS FOR. scripts/backfill-platform-state.ts reports two things it
// deliberately will not act on:
//
//   * ORPHAN LOGINS — a `user:email:<addr>` record whose tenant has no config
//     anywhere. The account still works today, because findUserByEmail falls
//     back to the legacy record, and stops working whenever that key expires.
//   * SLUG COLLISIONS — two tenant configs claiming one slug, where
//     tenants.slug is UNIQUE. The backfill names both and picks neither.
//
// Left alone they are reported on every run forever, and steady noise is how a
// real one gets missed. But they are somebody's account and somebody's
// restaurant, so deleting them is an operator decision, not a migration.
//
// THE SAFETY RULE, and it is the whole point of this script: nothing is deleted
// until it has been proved empty in POSTGRES — no orders, no dishes, no payment
// transactions, no platform_users row. A target with any of those is reported
// and skipped, however stale its Redis record looks. "It is obviously a test
// signup" is a guess; a row count is not.
//
// Dry run by default. --write also requires a backup to have been written, so a
// deletion is always recoverable from the file this prints.

import { getRedis, redisKey } from '../src/lib/redis.js';
import { parseTenantConfig } from '../src/lib/tenantConfig.js';
import { tenantsRepo } from '../src/lib/repo.js';
import { selectMany } from '../src/lib/supabaseAdmin.js';
import { writeFileSync } from 'node:fs';

const WRITE  = process.argv.includes('--write');
const BACKUP = (() => {
  const i = process.argv.indexOf('--backup');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

interface Target {
  key:      string;
  kind:     'orphan-login' | 'duplicate-config';
  tenantId: string;
  label:    string;
  value:    unknown;
}

/** Every table whose emptiness makes a tenant safe to forget. */
const DATA_TABLES = ['orders', 'dishes', 'payment_transactions', 'platform_users'] as const;

async function rowCounts(tenantId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of DATA_TABLES) {
    const rows = await selectMany<unknown>(t, {
      select: 'id', tenant_id: `eq.${tenantId}`, limit: '50',
    }).catch(() => { throw new Error(`could not count ${t} — refusing to delete blind`); });
    out[t] = rows.length;
  }
  return out;
}

async function findTargets(): Promise<Target[]> {
  const redis   = getRedis();
  const targets: Target[] = [];

  // ── Orphan logins ──────────────────────────────────────────────────────────
  const userKeys = await (redis as unknown as { keys(p: string): Promise<string[]> })
    .keys('user:email:*').catch(() => [] as string[]);

  for (const key of userKeys) {
    const rec = await redis.get<{ email?: string; tenantId?: string; slug?: string }>(key)
      .catch(() => null);
    if (!rec?.tenantId) continue;

    const hasConfig = await redis.get<unknown>(redisKey.tenantConfig(rec.tenantId)).catch(() => null);
    const hasRow    = await tenantsRepo.findById(rec.tenantId).catch(() => null);
    if (hasConfig || hasRow) continue;

    targets.push({
      key, kind: 'orphan-login', tenantId: rec.tenantId,
      label: `${rec.email ?? key} → tenant ${rec.tenantId} (slug "${rec.slug ?? '?'}")`,
      value: rec,
    });
  }

  // ── Duplicate configs claiming a slug someone else holds ───────────────────
  const cfgKeys = await (redis as unknown as { keys(p: string): Promise<string[]> })
    .keys('tenant:config:*').catch(() => [] as string[]);

  for (const key of cfgKeys) {
    const tenantId = key.slice('tenant:config:'.length);
    const raw = await redis.get<unknown>(key).catch(() => null);
    if (!raw) continue;

    let config;
    try { config = parseTenantConfig(raw); } catch { continue; }

    const holder = await tenantsRepo.findBySlug(config.slug).catch(() => null);
    if (!holder || holder.id === tenantId) continue;

    // The legacy pointer names whichever tenant the kiosk URL actually served.
    // If it names THIS one, this is the live tenant and the Postgres row is the
    // mistake — a case for a human, not a delete.
    const legacy = await redis.get<string>(`tenant:slug:${config.slug}`).catch(() => null);
    if (legacy === tenantId) {
      console.warn(`  ! ${tenantId}  slug "${config.slug}" — legacy key names THIS tenant, ` +
                   `but Postgres gives it to ${holder.id}. Not touching it; resolve by hand.`);
      continue;
    }

    targets.push({
      key, kind: 'duplicate-config', tenantId,
      label: `${config.restaurantName} (slug "${config.slug}" held by ${holder.id})`,
      value: raw,
    });
  }

  return targets;
}

async function main(): Promise<void> {
  console.log(WRITE ? '── Pruning stale Redis records ──'
                    : '── DRY RUN (pass --write to apply) ──\n');

  const targets = await findTargets();
  if (targets.length === 0) { console.log('\nNothing stale. Nothing to do.'); return; }

  const safe: Target[] = [];
  const held: Target[] = [];

  for (const t of targets) {
    const counts  = await rowCounts(t.tenantId);
    const total   = Object.values(counts).reduce((a, b) => a + b, 0);
    const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ');

    if (total === 0) { safe.push(t); console.log(`  · ${t.kind.padEnd(16)} ${t.label}\n      ${summary}`); }
    else             { held.push(t); console.log(`  ! ${t.kind.padEnd(16)} ${t.label}\n      ${summary}  <-- HAS DATA, keeping`); }
  }

  console.log(`\n  safe to remove ${safe.length}`);
  console.log(`  kept (has data) ${held.length}`);

  if (!WRITE) { console.log('\nNothing was deleted. Re-run with --write to apply.'); return; }

  if (!BACKUP) {
    console.error('\nRefusing to delete without --backup <file>. ' +
                  'Every deletion here must be recoverable from a file.');
    process.exitCode = 1;
    return;
  }

  const dump: Record<string, unknown> = { takenAt: new Date().toISOString() };
  for (const t of safe) dump[t.key] = t.value;
  writeFileSync(BACKUP, JSON.stringify(dump, null, 2));
  console.log(`\n  backup → ${BACKUP}  (contains password hashes — do not commit)`);

  const redis = getRedis();
  let removed = 0;
  for (const t of safe) {
    await redis.del(t.key);
    if (t.kind === 'duplicate-config') {
      await redis.srem(redisKey.tenantsIndex, t.tenantId).catch(() => undefined);
    }
    removed++;
  }
  console.log(`  removed ${removed} key(s)`);
}

main().catch(err => { console.error('[PRUNE]', (err as Error).message); process.exit(1); });
