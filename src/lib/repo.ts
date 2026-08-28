import * as db from './supabaseAdmin.js';
import type { TenantConfig } from './tenantConfig.js';
import type { EncryptedBlob } from './crypto.js';
import type {
  PaymentTransaction,
  PaymentProviderId,
  PaymentStatus,
  PaymentMethod,
} from '../../payments/IPaymentProvider.js';

// Repository layer for the platform's relational tables — tenants,
// tenant_configs, adapter_credentials, platform_users, audit_log and the
// durable payment_transactions ledger.
//
// Postgres is the source of truth for all of it. Redis is a cache in front of
// the hot reads (see src/lib/platformState.ts) and nothing more: a value that
// is only in Redis is a bug, and a value that is only in Postgres is merely
// cold. That ordering is what makes the cache safe to drop at any time.
//
// It did not always work this way. Until the reads-cutover these tables were
// written "dual-write" — Redis first as the real store, Postgres second on a
// fire-and-forget path whose failures were swallowed. That is how audit_log
// ran for its entire life writing nothing at all (see the EXPECTED_COLUMNS
// note in supabaseAdmin.ts). Two lessons are encoded below:
//
//   * mustWrite() for anything that IS the record. It throws, and the route
//     turns that into a 5xx, because a write that only reached the cache is
//     data loss the user has not been told about.
//   * bestEffort() for genuine side-effects, and it ALWAYS logs on failure.
//     Never a silent catch, at any log level.

// ── tenants ──────────────────────────────────────────────────────────────────

export interface TenantRow {
  id:                 string;
  slug:               string;
  name:               string;
  plan:               string;
  status:             string;
  stripe_customer_id: string | null;
  created_at:         string;
  updated_at:         string;
}

export const tenantsRepo = {
  async upsert(t: {
    id:    string;
    slug:  string;
    name:  string;
    plan?: string;
    status?: string;
  }): Promise<void> {
    await db.upsert('tenants', {
      id:     t.id,
      slug:   t.slug,
      name:   t.name,
      plan:   t.plan   ?? 'starter',
      status: t.status ?? 'active',
    }, 'id');
  },

  findById(id: string): Promise<TenantRow | null> {
    return db.selectOne<TenantRow>('tenants', { id: `eq.${id}` });
  },

  findBySlug(slug: string): Promise<TenantRow | null> {
    return db.selectOne<TenantRow>('tenants', { slug: `eq.${slug}` });
  },

  list(): Promise<TenantRow[]> {
    return db.selectMany<TenantRow>('tenants', { order: 'created_at.desc' });
  },
};

// ── tenant_configs ───────────────────────────────────────────────────────────

interface TenantConfigRow {
  tenant_id:  string;
  config:     TenantConfig;
  updated_at: string;
  updated_by: string | null;
}

export const tenantConfigsRepo = {
  async upsert(tenantId: string, config: TenantConfig, updatedBy?: string): Promise<void> {
    await db.upsert('tenant_configs', {
      tenant_id:  tenantId,
      config,
      updated_by: updatedBy ?? null,
    }, 'tenant_id');
  },

  async get(tenantId: string): Promise<TenantConfig | null> {
    const row = await db.selectOne<TenantConfigRow>('tenant_configs', {
      tenant_id: `eq.${tenantId}`,
    });
    return row?.config ?? null;
  },
};

// ── adapter_credentials ──────────────────────────────────────────────────────

interface CredentialRow {
  tenant_id:  string;
  ciphertext: string;
  iv:         string;
  algorithm:  string;
  updated_at: string;
}

export const credentialsRepo = {
  async upsert(tenantId: string, blob: EncryptedBlob): Promise<void> {
    await db.upsert('adapter_credentials', {
      tenant_id:  tenantId,
      ciphertext: blob.ciphertext,
      iv:         blob.iv,
      algorithm:  'aes-256-gcm',
    }, 'tenant_id');
  },

  async get(tenantId: string): Promise<EncryptedBlob | null> {
    const row = await db.selectOne<CredentialRow>('adapter_credentials', {
      tenant_id: `eq.${tenantId}`,
    });
    return row ? { ciphertext: row.ciphertext, iv: row.iv } : null;
  },
};

// ── platform_users ───────────────────────────────────────────────────────────

export type UserRole = 'tenant_admin' | 'manager' | 'staff' | 'kiosk';

// Stored in password_hash to disable an account. Login compares against a
// 64-char sha256 hex digest, so a value containing '!' can never match.
export const REVOKED_PASSWORD_HASH = '!revoked';

export interface PlatformUserRow {
  id:            string;
  tenant_id:     string;
  email:         string;
  password_hash: string;
  role:          UserRole;
  created_at:    string;
  last_login_at: string | null;
}

export const usersRepo = {
  async upsert(u: {
    tenantId:     string;
    email:        string;
    passwordHash: string;
    role:         UserRole;
  }): Promise<void> {
    await db.upsert('platform_users', {
      tenant_id:     u.tenantId,
      email:         u.email.toLowerCase(),
      password_hash: u.passwordHash,
      role:          u.role,
    }, 'email');
  },

  findByEmail(email: string): Promise<PlatformUserRow | null> {
    return db.selectOne<PlatformUserRow>('platform_users', {
      email: `eq.${email.toLowerCase()}`,
    });
  },

  // Lookup by the user UUID carried in the JWT `sub` claim, for routes that
  // have a session but not an email (see routes/billing.ts).
  findById(id: string): Promise<PlatformUserRow | null> {
    return db.selectOne<PlatformUserRow>('platform_users', { id: `eq.${id}` });
  },

  listByTenant(tenantId: string): Promise<PlatformUserRow[]> {
    return db.selectMany<PlatformUserRow>('platform_users', {
      tenant_id: `eq.${tenantId}`,
      order:     'created_at.asc',
    });
  },

  /**
   * Revoke a login without deleting the account.
   *
   * The row is deliberately kept: historical orders carry staff_id, and removing
   * it would turn every past sale, void and drawer count by that person into an
   * unattributable uuid. Instead the stored hash is replaced with a sentinel
   * that no digest can equal, so the credential stops working while the identity
   * survives for the audit trail.
   *
   * This became load-bearing when login moved to Postgres. Removing a staff
   * member used to mean deleting their `user:email:<addr>` Redis record, which
   * was the whole login; against platform_users that delete no longer revokes
   * anything, and a sacked cashier would keep their password.
   */
  async revokeLogin(email: string): Promise<void> {
    await db.update('platform_users', { email: `eq.${email.toLowerCase()}` }, {
      password_hash: REVOKED_PASSWORD_HASH,
    });
  },

  async touchLastLogin(email: string): Promise<void> {
    await db.upsert('platform_users', {
      email:         email.toLowerCase(),
      last_login_at: new Date().toISOString(),
    } as unknown as { email: string; last_login_at: string }, 'email');
  },
};

// ── audit_log ────────────────────────────────────────────────────────────────

export const auditRepo = {
  async append(entry: {
    tenantId: string;
    actor:    string;
    action:   string;
    details?: string;
  }): Promise<void> {
    await db.insert('audit_log', {
      tenant_id: entry.tenantId,
      actor:     entry.actor,
      action:    entry.action,
      details:   entry.details ?? null,
    });
  },
};

// ── payment_transactions ─────────────────────────────────────────────────────
// The durable record of every diner card payment attempt. Provisioned by
// migrations/002_payments.sql, unreachable from code until now: payments lived
// only in Redis under `payment:<ref>` with a 30-day TTL, so the record of a
// customer's card payment evaporated a month after they made it.
//
// NEVER stores PAN / card / EMV data — only the gateway's own reference and the
// outcome, which is all reconciliation against a settlement file needs.

interface PaymentTxRow {
  id:           string;
  tenant_id:    string;
  order_id:     string | null;
  provider:     PaymentProviderId;
  provider_ref: string;
  amount_paisa: number;
  currency:     string;
  status:       PaymentStatus;
  method:       PaymentMethod;
  created_at:   string;
  updated_at:   string;
}

function toTransaction(row: PaymentTxRow): PaymentTransaction {
  return {
    providerRef: row.provider_ref,
    provider:    row.provider,
    tenantId:    row.tenant_id,
    orderId:     row.order_id ?? '',
    amountPaisa: Number(row.amount_paisa),
    currency:    row.currency,
    status:      row.status,
    method:      row.method,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
}

export const paymentsRepo = {
  /**
   * Write the payment attempt. Upserts on (provider, provider_ref) — the unique
   * index from migration 002 — so a retried checkout or a redelivered webhook
   * converges on one row instead of stacking duplicate attempts.
   *
   * Only called where the order is known to exist (the checkout route looks it
   * up first), because order_id carries a foreign key into public.orders.
   */
  async record(txn: PaymentTransaction): Promise<void> {
    await db.upsert('payment_transactions', {
      tenant_id:    txn.tenantId,
      order_id:     txn.orderId || null,
      provider:     txn.provider,
      provider_ref: txn.providerRef,
      amount_paisa: txn.amountPaisa,
      currency:     txn.currency,
      status:       txn.status,
      method:       txn.method,
    }, 'provider,provider_ref');
  },

  /**
   * Advance an existing attempt's outcome.
   *
   * Deliberately a partial update rather than a full upsert: the webhook and
   * status-poll paths know the new status but should not re-assert order_id,
   * whose FK is `on delete set null`. Re-sending a stale order id would turn a
   * routine status change into a constraint violation on a payment we have
   * already taken.
   */
  async updateStatus(
    providerRef: string,
    status:      PaymentStatus,
    amountPaisa?: number,
  ): Promise<void> {
    const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
    if (amountPaisa !== undefined) patch.amount_paisa = amountPaisa;
    await db.update('payment_transactions', { provider_ref: `eq.${providerRef}` }, patch);
  },

  /**
   * Durable lookup behind the Redis hot record. Matches on provider_ref alone
   * because that is all the Redis key ever carried; the gateway reference is
   * unique in practice, and the composite index still guards insertion.
   */
  async findByRef(providerRef: string): Promise<PaymentTransaction | null> {
    const row = await db.selectOne<PaymentTxRow>('payment_transactions', {
      provider_ref: `eq.${providerRef}`,
    });
    return row ? toTransaction(row) : null;
  },

  async findByOrder(tenantId: string, orderId: string): Promise<PaymentTransaction[]> {
    const rows = await db.selectMany<PaymentTxRow>('payment_transactions', {
      tenant_id: `eq.${tenantId}`,
      order_id:  `eq.${orderId}`,
      order:     'created_at.desc',
    });
    return rows.map(toTransaction);
  },
};

// ── write helpers for callers ────────────────────────────────────────────────

/**
 * Await a Postgres write that IS the record, and let it throw.
 *
 * Every caller sits inside a route's try/catch and answers 5xx, which is the
 * point: if the tenant row, its config, its credentials or its admin user did
 * not reach Postgres, the operation did not happen and the caller must be told
 * so they can retry. Writing only to the Redis cache and reporting success is
 * how state drifts apart invisibly.
 *
 * Errors are re-thrown with the label attached so the route log names the table
 * rather than just repeating PostgREST's message.
 */
export async function mustWrite(label: string, op: Promise<unknown>): Promise<void> {
  try {
    await op;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[DB] write FAILED (${label}): ${msg}`);
    throw new Error(`${label}: ${msg}`);
  }
}

/**
 * Await a genuine side-effect that must never fail its caller — today only the
 * audit trail, which per the project's rules is written after money has already
 * moved and cannot be allowed to turn a committed sale into a 5xx.
 *
 * Unlike the dualWrite() it replaces, this logs at error level unconditionally.
 * The old version logged only when NODE_ENV === 'development', which is exactly
 * why a schema mismatch on audit_log went unnoticed in production for the whole
 * life of the feature. Best-effort means "does not throw", not "is invisible".
 */
export async function bestEffort(label: string, op: Promise<unknown>): Promise<void> {
  try {
    await op;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[DB] best-effort write failed (${label}): ${msg}`);
  }
}
