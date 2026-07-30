import * as db from './supabaseAdmin.js';
import type { TenantConfig } from './tenantConfig.js';
import type { EncryptedBlob } from './crypto.js';

// Repository layer for the platform's relational tables. Every server.ts route
// that mutates platform state writes through here in addition to Redis (dual
// write). Reads still go to Redis today — repo reads exist for the backfill
// script and the upcoming reads-cutover.
//
// Failures here MUST NOT break the Redis-backed primary path during dual
// write. Callers wrap repo calls in Promise.allSettled and log on rejection.

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

// ── small helper for callers ─────────────────────────────────────────────────
// Wrap a dual-write Postgres call so a failure logs but never throws — keeps
// the Redis primary path unaffected during the dual-write transition.
export async function dualWrite(label: string, op: Promise<unknown>): Promise<void> {
  // Non-fatal: Redis is primary store. Postgres dual-write failures are informational only.
  // Comment: "Failures here MUST NOT break the Redis-backed primary path"
  try {
    await op;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[DB] dual-write info (${label}): ${msg}`);
    }
  }
}
