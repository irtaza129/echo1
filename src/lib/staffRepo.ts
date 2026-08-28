import * as db from './supabaseAdmin.js';
import { getRedis } from './redis.js';
import { verifyPin } from './pin.js';

// Staff identity at the till: who is ringing this in, and what are they allowed
// to do without a manager.
//
// Distinct from the tenant session. The terminal logs in once as the tenant and
// stays logged in all shift; the PIN identifies the OPERATOR per action, which
// is what makes staff_id on an order and approved-by on a void mean anything.

export interface PosPermissions {
  can_void:         boolean;
  can_discount:     boolean;
  can_refund:       boolean;
  can_close_shift:  boolean;
  can_open_drawer:  boolean;
  /** Ceiling for a discount this operator can apply unaided, as a percentage. */
  max_discount_pct: number;
}

// Absent keys read as false / 0. The default is fail-closed: a capability is
// held only when someone explicitly granted it.
export const NO_PERMISSIONS: PosPermissions = {
  can_void: false, can_discount: false, can_refund: false,
  can_close_shift: false, can_open_drawer: false, max_discount_pct: 0,
};

export function normalisePermissions(raw: unknown): PosPermissions {
  const p = (raw ?? {}) as Record<string, unknown>;
  const bool = (v: unknown) => v === true;
  const pct  = Number(p.max_discount_pct);
  return {
    can_void:         bool(p.can_void),
    can_discount:     bool(p.can_discount),
    can_refund:       bool(p.can_refund),
    can_close_shift:  bool(p.can_close_shift),
    can_open_drawer:  bool(p.can_open_drawer),
    max_discount_pct: Number.isFinite(pct) ? Math.min(Math.max(pct, 0), 100) : 0,
  };
}

interface StaffRow {
  id:              string;
  tenant_id:       string;
  email:           string;
  role:            string;
  pin_hash:        string | null;
  pos_permissions: unknown;
}

export interface IdentifiedStaff {
  staffId:     string;
  email:       string;
  role:        string;
  permissions: PosPermissions;
}

// ── Online guessing lockout ──────────────────────────────────────────────────
// The real defence for a 4-digit PIN. scrypt makes an offline sweep expensive;
// only this stops someone standing at an unattended terminal working through
// 10,000 candidates.
//
// Scoped per tenant, not per user: the attempt does not name a user (the PIN
// is the lookup key), so there is nobody to attribute a failure to until it
// succeeds. Locking the terminal for a minute is a small cost to staff and a
// large one to an attacker — 5 tries a minute is 33 hours for the full space.

const MAX_ATTEMPTS  = 5;
const WINDOW_SEC    = 60;
const lockKey = (tenantId: string) => `pos:pinfail:${tenantId}`;

export interface LockoutState { locked: boolean; remaining: number }

export async function checkLockout(tenantId: string): Promise<LockoutState> {
  try {
    const n = Number(await getRedis().get<number | string>(lockKey(tenantId))) || 0;
    return { locked: n >= MAX_ATTEMPTS, remaining: Math.max(0, MAX_ATTEMPTS - n) };
  } catch {
    // Redis unavailable. Fail OPEN here, deliberately: the alternative locks
    // every till in every restaurant out of the POS during a cache outage,
    // which is a worse and far more likely incident than a PIN-guessing
    // attempt that happens to coincide with it.
    return { locked: false, remaining: MAX_ATTEMPTS };
  }
}

export async function recordFailure(tenantId: string): Promise<void> {
  try {
    const redis = getRedis();
    const key   = lockKey(tenantId);
    const n     = await redis.incr(key);
    // Set the window on the first failure only, so the lock is a rolling
    // 60 seconds from the first bad try rather than being extended forever by
    // an attacker who keeps guessing.
    if (n === 1) await redis.expire(key, WINDOW_SEC);
  } catch { /* see checkLockout — a counter we cannot write is not fatal */ }
}

export async function clearFailures(tenantId: string): Promise<void> {
  try { await getRedis().del(lockKey(tenantId)); } catch { /* non-fatal */ }
}

// ── Lookup ───────────────────────────────────────────────────────────────────

/**
 * Find which staff member in this tenant owns `pin`.
 *
 * Every candidate is checked even after a match is found. Returning early would
 * make response time depend on the matching user's position in the list, which
 * leaks roughly where in the table a valid PIN sits — cheap to avoid, and the
 * candidate set is a handful of rows.
 */
export async function identifyByPin(tenantId: string, pin: string): Promise<IdentifiedStaff | null> {
  const rows = await db.selectMany<StaffRow>('platform_users', {
    tenant_id: `eq.${tenantId}`,
    pin_hash:  'not.is.null',
    select:    'id,tenant_id,email,role,pin_hash,pos_permissions',
  });

  let found: StaffRow | null = null;
  for (const row of rows) {
    if (row.pin_hash && await verifyPin(pin, row.pin_hash) && !found) found = row;
  }
  if (!found) return null;

  return {
    staffId:     found.id,
    email:       found.email,
    role:        found.role,
    permissions: normalisePermissions(found.pos_permissions),
  };
}

export async function findByEmail(tenantId: string, email: string): Promise<StaffRow | null> {
  return db.selectOne<StaffRow>('platform_users', {
    tenant_id: `eq.${tenantId}`,
    email:     `eq.${email.toLowerCase()}`,
    select:    'id,tenant_id,email,role,pin_hash,pos_permissions',
  });
}

/**
 * Find a staff member, creating their Postgres row from the Redis record if it
 * is missing.
 *
 * Staff invites (`POST /api/admin/staff/invite`) historically wrote ONLY to
 * Redis (`user:email:<email>`), while signup wrote `platform_users`. So every
 * cashier and manager ever invited exists as a login but has no row in the
 * table this module reads — which made "set a PIN for my cashier" fail with a
 * 404 for exactly the people PINs are for.
 *
 * The invite route now writes both. This backfills the ones that predate that
 * fix, on first use, so no separate migration script has to be run and
 * remembered.
 *
 * The Redis record's tenantId is re-checked against the caller's tenant before
 * anything is written: the key is global, and trusting it blindly would let one
 * tenant provision a row for another tenant's user.
 */
export async function findOrProvision(tenantId: string, email: string): Promise<StaffRow | null> {
  const existing = await findByEmail(tenantId, email);
  if (existing) return existing;

  const lower = email.toLowerCase();

  let legacy: { tenantId?: string; passwordHash?: string; role?: string } | null = null;
  try {
    legacy = await getRedis().get<{ tenantId?: string; passwordHash?: string; role?: string }>(
      `user:email:${lower}`,
    );
  } catch {
    return null;   // Redis down — report "not found" rather than inventing a row
  }

  if (!legacy || legacy.tenantId !== tenantId) return null;

  const role = legacy.role === 'manager' || legacy.role === 'staff' || legacy.role === 'kiosk'
    ? legacy.role
    : 'staff';

  await db.upsert('platform_users', {
    tenant_id:     tenantId,
    email:         lower,
    // Carried across as-is. It is a sha256 digest, which is weak, but it is the
    // same value the Redis login already accepts — rewriting it here would lock
    // the person out of the login they have been using.
    password_hash: legacy.passwordHash ?? '',
    role,
  }, 'email');

  console.log(`[STAFF] provisioned platform_users row for ${lower} (tenant ${tenantId})`);
  return findByEmail(tenantId, email);
}

export async function setPin(tenantId: string, staffId: string, pinHash: string): Promise<void> {
  await db.update('platform_users', { id: `eq.${staffId}`, tenant_id: `eq.${tenantId}` }, {
    pin_hash: pinHash, pin_set_at: new Date().toISOString(),
  });
}

export async function clearPin(tenantId: string, staffId: string): Promise<void> {
  await db.update('platform_users', { id: `eq.${staffId}`, tenant_id: `eq.${tenantId}` }, {
    pin_hash: null, pin_set_at: null,
  });
}

export async function setPermissions(
  tenantId: string, staffId: string, permissions: PosPermissions,
): Promise<void> {
  await db.update('platform_users', { id: `eq.${staffId}`, tenant_id: `eq.${tenantId}` }, {
    pos_permissions: permissions,
  });
}

export async function listStaff(tenantId: string): Promise<Array<{
  staffId: string; email: string; role: string; hasPin: boolean; permissions: PosPermissions;
}>> {
  const rows = await db.selectMany<StaffRow & { pin_set_at: string | null }>('platform_users', {
    tenant_id: `eq.${tenantId}`,
    select:    'id,email,role,pin_hash,pin_set_at,pos_permissions',
    order:     'email.asc',
  });
  // pin_hash is read to derive hasPin and is never returned to the browser.
  return rows.map(r => ({
    staffId:     r.id,
    email:       r.email,
    role:        r.role,
    hasPin:      Boolean(r.pin_hash),
    permissions: normalisePermissions(r.pos_permissions),
  }));
}
