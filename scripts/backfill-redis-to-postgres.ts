// One-shot backfill: copy every tenant currently in Redis into the Postgres
// tables created by db/schema.sql. Run after applying the schema and before
// flipping reads to Postgres-first.
//
//   npx tsx scripts/backfill-redis-to-postgres.ts
//   npx tsx scripts/backfill-redis-to-postgres.ts --dry-run
//
// Idempotent — every write goes through repo upserts so re-running is safe.
// Logs a per-tenant summary so partial failures are visible.

import 'dotenv/config';
import { getRedis, redisKey } from '../src/lib/redis.js';
import { parseTenantConfig, type TenantConfig } from '../src/lib/tenantConfig.js';
import { tenantsRepo, tenantConfigsRepo, credentialsRepo, usersRepo } from '../src/lib/repo.js';
import type { EncryptedBlob } from '../src/lib/crypto.js';

interface UserRow {
  email:        string;
  passwordHash: string;
  tenantId:     string;
  slug:         string;
  role:         'tenant_admin' | 'manager' | 'staff' | 'kiosk';
}

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  const redis = getRedis();

  // 1. Tenants — enumerate from tenants:index set
  const tenantIds = (await redis.smembers(redisKey.tenantsIndex)) as string[];
  console.log(`[BACKFILL] ${tenantIds.length} tenants in Redis index`);

  let tenantsOk = 0;
  let configsOk = 0;
  let credsOk   = 0;

  for (const tenantId of tenantIds) {
    const configRaw = await redis.get<unknown>(redisKey.tenantConfig(tenantId)).catch(() => null);
    if (!configRaw) {
      console.warn(`[BACKFILL] skip ${tenantId} — no config in Redis`);
      continue;
    }

    let config: TenantConfig;
    try {
      config = parseTenantConfig(configRaw);
    } catch (err) {
      console.warn(`[BACKFILL] skip ${tenantId} — config failed validation:`, (err as Error).message);
      continue;
    }

    if (DRY_RUN) {
      console.log(`[BACKFILL] would write ${tenantId} (${config.slug}, ${config.restaurantName})`);
      continue;
    }

    try {
      await tenantsRepo.upsert({
        id:     config.tenantId,
        slug:   config.slug,
        name:   config.restaurantName,
        plan:   config.plan,
        status: 'active',
      });
      tenantsOk++;

      await tenantConfigsRepo.upsert(config.tenantId, config, 'backfill-script');
      configsOk++;
    } catch (err) {
      console.error(`[BACKFILL] tenant ${tenantId} failed:`, (err as Error).message);
      continue;
    }

    // Credentials, if any
    const blob = await redis.get<EncryptedBlob>(redisKey.credentialsKey(tenantId)).catch(() => null);
    if (blob) {
      try {
        await credentialsRepo.upsert(tenantId, blob);
        credsOk++;
      } catch (err) {
        console.warn(`[BACKFILL] credentials ${tenantId} failed:`, (err as Error).message);
      }
    }
  }

  // 2. Users — Redis stores them under `user:email:<email>`. SCAN to find all.
  let usersOk = 0;
  let cursor: string | number = 0;
  do {
    const [next, keys] = (await redis.scan(cursor, { match: 'user:email:*', count: 100 })) as [string | number, string[]];
    cursor = next;
    for (const key of keys) {
      const u = await redis.get<UserRow>(key).catch(() => null);
      if (!u?.email) continue;
      if (DRY_RUN) {
        console.log(`[BACKFILL] would write user ${u.email} (tenant=${u.tenantId})`);
        continue;
      }
      try {
        await usersRepo.upsert({
          tenantId:     u.tenantId,
          email:        u.email,
          passwordHash: u.passwordHash,
          role:         u.role ?? 'tenant_admin',
        });
        usersOk++;
      } catch (err) {
        console.warn(`[BACKFILL] user ${u.email} failed:`, (err as Error).message);
      }
    }
  } while (String(cursor) !== '0');

  console.log(`[BACKFILL] done — tenants=${tenantsOk} configs=${configsOk} credentials=${credsOk} users=${usersOk}${DRY_RUN ? ' (dry-run)' : ''}`);
}

run().catch(err => {
  console.error('[BACKFILL] fatal:', err);
  process.exit(1);
});
