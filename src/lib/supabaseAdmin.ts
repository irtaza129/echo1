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
