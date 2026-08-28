import { getRedis, redisKey, TTL } from './redis.js';
import { parseTenantConfig, type TenantConfig, type AdapterCredentials } from './tenantConfig.js';
import { decryptCredentials, type EncryptedBlob } from './crypto.js';
import {
  tenantsRepo,
  tenantConfigsRepo,
  credentialsRepo,
  usersRepo,
  mustWrite,
  bestEffort,
  type UserRole,
} from './repo.js';

// ─────────────────────────────────────────────────────────────────────────────
// Platform state — tenant configs, adapter credentials, slug routing, and the
// admin user records behind login.
//
// Postgres is the source of truth. Redis is a cache in front of it and holds
// nothing that cannot be rebuilt from a query. That is a change from how this
// used to work, and the direction matters:
//
//   BEFORE  read Redis → miss → hardcoded fallback → 404
//           write Redis (awaited) → Postgres (fire-and-forget, errors dropped)
//
//   NOW     read Redis → miss → Postgres → warm cache → 404
//           write Postgres (awaited, throws) → Redis
//
// Under the old order a Redis eviction was data loss, which is why the tenant
// config TTL had crept up to a year with a comment warning that a shorter one
// "causes data loss". A cache cannot lose data; a store can. The one-year TTL
// was the tell that Redis had quietly become the store.
//
// Writes go to Postgres FIRST and only then update the cache. That ordering is
// what makes a cache read safe: the cache can lag Postgres (harmless — it
// expires), but it can never hold a value Postgres never accepted, which is the
// state that silently forks the two.
//
// Every read here degrades to Postgres when Redis is unavailable. None degrades
// the other way: if Postgres is down the platform is down regardless, since the
// order ledger lives there too.
// ─────────────────────────────────────────────────────────────────────────────

// ── Tenant config ────────────────────────────────────────────────────────────

/**
 * Resolve a tenant's config: cache, then Postgres, then nothing.
 *
 * Returns null rather than throwing when the tenant genuinely does not exist —
 * callers distinguish "unknown tenant" (404) from "lookup failed" (500) by
 * whether this throws, and a missing row is not a failure.
 */
export async function readTenantConfig(tenantId: string): Promise<TenantConfig | null> {
  try {
    const cached = await getRedis().get<unknown>(redisKey.tenantConfig(tenantId));
    if (cached) return parseTenantConfig(cached);
  } catch {
    // Cache unavailable or holding an unparseable value — fall through to the
    // source of truth rather than failing the request.
  }

  const stored = await tenantConfigsRepo.get(tenantId);
  if (!stored) return null;

  const config = parseTenantConfig(stored);
  void warmTenantConfig(config);
  return config;
}

/**
 * Persist a tenant's config, then refresh the cache.
 *
 * Throws if Postgres rejects the write. Callers must let that reach the client:
 * reporting success for a config that only landed in the cache is how an admin
 * comes back the next day to find their settings reverted.
 */
export async function writeTenantConfig(
  tenantId:   string,
  config:     TenantConfig,
  updatedBy?: string,
): Promise<void> {
  await mustWrite('tenant_configs.upsert', tenantConfigsRepo.upsert(tenantId, config, updatedBy));
  // Keep the tenants row in step — slug, name and plan are edited through the
  // same config screen, and slug routing reads them from there.
  await mustWrite('tenants.upsert', tenantsRepo.upsert({
    id:   tenantId,
    slug: config.slug,
    name: config.restaurantName,
    plan: config.plan,
  }));
  await warmTenantConfig(config);
}

/** Refresh the cached copy. Never throws — a cold cache is only a slow read. */
export async function warmTenantConfig(config: TenantConfig): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(redisKey.tenantConfig(config.tenantId), config, { ex: TTL.TENANT_CONFIG });
    // Membership of the scan index is idempotent, and legacy tenants predating
    // the signup flow were never added to it.
    await redis.sadd(redisKey.tenantsIndex, config.tenantId).catch(() => undefined);
  } catch {
    // Non-fatal by definition.
  }
}

/** Drop the cached copy so the next read reloads from Postgres. */
export async function invalidateTenantConfig(tenantId: string): Promise<void> {
  try {
    await getRedis().del(redisKey.tenantConfig(tenantId));
  } catch {
    // Non-fatal — the entry expires on its own.
  }
}

// ── Adapter credentials ──────────────────────────────────────────────────────

/**
 * The encrypted credential blob for a tenant: cache, then Postgres.
 *
 * Ciphertext only — decryption happens in the caller so the key stays in one
 * place (src/lib/crypto.ts) and a plaintext credential is never cached.
 */
export async function readCredentialBlob(tenantId: string): Promise<EncryptedBlob | null> {
  try {
    const cached = await getRedis().get<EncryptedBlob>(redisKey.credentialsKey(tenantId));
    if (cached) return cached;
  } catch {
    // Fall through to Postgres.
  }

  const stored = await credentialsRepo.get(tenantId);
  if (!stored) return null;

  try {
    await getRedis().set(redisKey.credentialsKey(tenantId), stored);
  } catch { /* non-fatal */ }
  return stored;
}

/**
 * Decrypted credentials, or an empty set.
 *
 * Returns {} rather than throwing when there are none or when decryption fails:
 * a managed tenant has no credentials at all, and a custom_api tenant surfaces
 * the problem when the adapter actually tries to use one. Failing here would
 * take down every agent route for a tenant whose payment keys are misconfigured.
 */
export async function readCredentials(tenantId: string): Promise<AdapterCredentials> {
  try {
    const blob = await readCredentialBlob(tenantId);
    return blob ? decryptCredentials(blob) : {};
  } catch {
    return {};
  }
}

/** Persist credentials, then refresh the cache. Throws if Postgres rejects. */
export async function writeCredentials(tenantId: string, blob: EncryptedBlob): Promise<void> {
  await mustWrite('adapter_credentials.upsert', credentialsRepo.upsert(tenantId, blob));
  try {
    await getRedis().set(redisKey.credentialsKey(tenantId), blob);
  } catch { /* non-fatal */ }
}

// ── Slug → tenant routing ────────────────────────────────────────────────────

const LEGACY_SLUG_KEY  = (slug: string)  => `tenant:slug:${slug}`;
const LEGACY_EMAIL_KEY = (email: string) => `user:email:${email.toLowerCase()}`;
const LEGACY_TTL       = 365 * 24 * 60 * 60;

/**
 * Map a public slug to its tenant id.
 *
 * Postgres first, because this mapping decides which restaurant a kiosk URL
 * serves — a stale cache entry here shows one tenant's menu under another's
 * slug. The legacy `tenant:slug:<x>` key is consulted only as a fallback for
 * tenants registered before the relational tables existed, and a hit there is
 * healed forward so the next lookup does not need it.
 *
 * Callers must apply the reserved-slug guard BEFORE calling this.
 */
export async function resolveSlug(slug: string): Promise<string | null> {
  const row = await tenantsRepo.findBySlug(slug).catch(() => null);
  if (row) return row.id;

  let legacyId: string | null = null;
  try {
    legacyId = await getRedis().get<string>(LEGACY_SLUG_KEY(slug));
  } catch {
    return null;
  }
  if (!legacyId) return null;

  console.warn(`[PLATFORM] slug "${slug}" resolved from legacy Redis key — healing into Postgres`);
  const config = await readTenantConfig(legacyId).catch(() => null);
  if (config) {
    // Best-effort: healing is a repair on a read path, and failing it would
    // turn a working legacy kiosk URL into a 500. The warn above is the signal
    // that this tenant still needs scripts/backfill-platform-state.ts.
    await bestEffort('tenants.upsert(heal)', tenantsRepo.upsert({
      id: legacyId, slug, name: config.restaurantName, plan: config.plan,
    }));
  }
  return legacyId;
}

/** Whether a slug is already taken, by either store. Used by the signup guard. */
export async function slugExists(slug: string): Promise<boolean> {
  return (await resolveSlug(slug)) !== null;
}

// ── Platform users ───────────────────────────────────────────────────────────

export interface PlatformUser {
  email:        string;
  passwordHash: string;
  tenantId:     string;
  slug:         string;
  role:         UserRole;
}

interface LegacyUserRecord {
  email:        string;
  passwordHash: string;
  tenantId:     string;
  slug:         string;
  role:         UserRole;
}

/**
 * Look up a login by email.
 *
 * Postgres first — it holds the authoritative password hash. The legacy
 * `user:email:<addr>` record is a fallback for accounts created while Redis was
 * the store, and a hit there is healed into Postgres so the account survives
 * the cache entry expiring. Without that heal, flipping reads to Postgres would
 * lock out every tenant whose dual-write had silently failed.
 *
 * The slug is not a column on platform_users; it comes from the tenants row,
 * which is where a config rename keeps it current.
 */
export async function findUserByEmail(email: string): Promise<PlatformUser | null> {
  const addr = email.toLowerCase();

  const row = await usersRepo.findByEmail(addr).catch(() => null);
  if (row) {
    const tenant = await tenantsRepo.findById(row.tenant_id).catch(() => null);
    return {
      email:        row.email,
      passwordHash: row.password_hash,
      tenantId:     row.tenant_id,
      slug:         tenant?.slug ?? row.tenant_id,
      role:         row.role,
    };
  }

  let legacy: LegacyUserRecord | null = null;
  try {
    legacy = await getRedis().get<LegacyUserRecord>(LEGACY_EMAIL_KEY(addr));
  } catch {
    return null;
  }
  if (!legacy) return null;

  console.warn(`[PLATFORM] user ${addr} found only in legacy Redis record — healing into Postgres`);
  try {
    await usersRepo.upsert({
      tenantId:     legacy.tenantId,
      email:        addr,
      passwordHash: legacy.passwordHash,
      role:         legacy.role,
    });
  } catch (err) {
    console.error(`[PLATFORM] heal of user ${addr} failed:`, (err as Error).message);
  }
  return legacy;
}

/** Whether an email is already registered, in either store. */
export async function emailExists(email: string): Promise<boolean> {
  return (await findUserByEmail(email)) !== null;
}

/**
 * Create the admin user for a newly registered tenant.
 *
 * Postgres is the write that counts; the legacy Redis record is still written
 * so a rollback to the previous build keeps working, and expires on its own.
 */
export async function createUser(u: PlatformUser): Promise<void> {
  await mustWrite('platform_users.upsert', usersRepo.upsert({
    tenantId:     u.tenantId,
    email:        u.email.toLowerCase(),
    passwordHash: u.passwordHash,
    role:         u.role,
  }));
  try {
    const redis = getRedis();
    await redis.set(LEGACY_EMAIL_KEY(u.email), u, { ex: LEGACY_TTL });
    await redis.set(LEGACY_SLUG_KEY(u.slug), u.tenantId, { ex: LEGACY_TTL });
  } catch { /* non-fatal — Postgres already has it */ }
}
