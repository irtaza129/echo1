import axios, { type AxiosInstance } from 'axios';

// Thin wrapper around Supabase's PostgREST endpoint, used as the platform's
// relational source of truth (tenants, tenant_configs, adapter_credentials,
// platform_users, audit_log). Follows the same shape as supabaseMenu.ts — no
// new npm dep, no @supabase/supabase-js — so the bundle stays small.
//
// All writes use the service-role key, which bypasses RLS. RLS policies in
// db/schema.sql exist as scaffolding for the day we move to anon + per-request
// JWT — they do not gate today's traffic.

let _client: AxiosInstance | null = null;

function client(): AxiosInstance {
  if (_client) return _client;
  const base = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY;
  if (!base || !key) {
    throw new Error('[DB] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  _client = axios.create({
    baseURL: `${base}/rest/v1`,
    timeout: 15_000,
    headers: {
      apikey:        key,
      Authorization: `Bearer ${key}`,
      'Content-Type':'application/json',
      Accept:        'application/json',
    },
  });
  return _client;
}

// Upsert a row, merging on the given conflict target (must match a unique
// constraint). PostgREST applies `resolution=merge-duplicates` to make the
// insert idempotent — same call works for create and update.
export async function upsert<T extends object>(
  table: string,
  row: T,
  onConflict: string,
): Promise<void> {
  await client().post(`/${table}?on_conflict=${onConflict}`, row, {
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  });
}

export async function selectOne<T>(
  table: string,
  filters: Record<string, string>,
): Promise<T | null> {
  const res = await client().get<T[]>(`/${table}`, {
    params: { ...filters, limit: '1' },
  });
  const rows = res.data ?? [];
  return rows[0] ?? null;
}

export async function selectMany<T>(
  table: string,
  filters: Record<string, string>,
): Promise<T[]> {
  const res = await client().get<T[]>(`/${table}`, { params: filters });
  return res.data ?? [];
}

export async function insert<T extends object>(
  table: string,
  row: T,
): Promise<void> {
  await client().post(`/${table}`, row, {
    headers: { Prefer: 'return=minimal' },
  });
}

// ── Boot-time schema assertion ────────────────────────────────────────────────
// Every column this app writes, per table. Kept next to the write helpers so it
// is obvious it must be updated when a repo write changes.
//
// This exists because audit_log was deployed with (actor_id, payload) while the
// code wrote (actor, details). Every insert failed with PGRST204, dualWrite()
// swallowed it, and the audit trail silently recorded nothing for the entire
// life of the feature. A single startup check would have caught it on day one.
const EXPECTED_COLUMNS: Record<string, string[]> = {
  tenants:             ['id', 'slug', 'name', 'plan', 'status'],
  tenant_configs:      ['tenant_id', 'config', 'updated_by', 'updated_at'],
  adapter_credentials: ['tenant_id', 'ciphertext', 'iv', 'algorithm', 'updated_at'],
  platform_users:      ['tenant_id', 'email', 'password_hash', 'role', 'last_login_at'],
  audit_log:           ['tenant_id', 'actor', 'action', 'details'],
};

export interface SchemaProblem {
  table:   string;
  missing: string[];
}

// Reads PostgREST's OpenAPI document (one request, no writes) and compares the
// live columns against EXPECTED_COLUMNS.
//
// Returns problems rather than throwing: a schema drift should be loud in the
// logs but must not stop the server booting, since Redis is the primary store
// and the kiosk works without Postgres. Callers decide how noisy to be.
export async function checkSchema(): Promise<SchemaProblem[]> {
  const res  = await client().get<{ definitions?: Record<string, { properties?: Record<string, unknown> }> }>('/');
  const defs = res.data?.definitions ?? {};
  const problems: SchemaProblem[] = [];

  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    const live = defs[table]?.properties;
    if (!live) { problems.push({ table, missing: ['<table not found>'] }); continue; }
    const missing = expected.filter(c => !(c in live));
    if (missing.length) problems.push({ table, missing });
  }

  return problems;
}
