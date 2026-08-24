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
  try {
    await client().post(`/${table}?on_conflict=${onConflict}`, row, {
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    });
  } catch (err) {
    const axiosErr = err as any;
    const detail = axiosErr?.response?.data?.message || axiosErr?.response?.data?.details || axiosErr?.message;
    throw new Error(`Upsert ${table} failed: ${detail}`);
  }
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

// Insert one row and get it back with server-generated columns (id, created_at,
// defaults) populated — used by repos that need the row's id for a follow-up
// write (e.g. order_items referencing the new order).
export async function insertReturning<T>(table: string, row: object): Promise<T> {
  const res = await client().post<T[]>(`/${table}`, row, {
    headers: { Prefer: 'return=representation' },
  });
  const inserted = res.data?.[0];
  if (!inserted) throw new Error(`Insert into ${table} did not return a row`);
  return inserted;
}

// Bulk insert, no rows returned — for child rows the caller already has
// everything it needs for (order_items, reservation_tables).
export async function insertMany<T extends object>(table: string, rows: T[]): Promise<void> {
  if (rows.length === 0) return;
  await client().post(`/${table}`, rows, {
    headers: { Prefer: 'return=minimal' },
  });
}

// Partial update matching `filters` (PostgREST operator syntax, e.g. { id: 'eq.123' }).
export async function update(table: string, filters: Record<string, string>, patch: object): Promise<void> {
  await client().patch(`/${table}`, patch, {
    params: filters,
    headers: { Prefer: 'return=minimal' },
  });
}

// Same as `update`, but returns the updated row(s) — for callers that need the
// post-update state (e.g. a computed variance) without a second round trip.
export async function updateReturning<T>(table: string, filters: Record<string, string>, patch: object): Promise<T[]> {
  const res = await client().patch<T[]>(`/${table}`, patch, {
    params: filters,
    headers: { Prefer: 'return=representation' },
  });
  return res.data ?? [];
}

export async function remove(table: string, filters: Record<string, string>): Promise<void> {
  await client().delete(`/${table}`, { params: filters });
}

// Calls a Postgres function exposed by PostgREST at /rpc/<fn> — used for
// pos_next_order_number, which must allocate atomically under concurrent tills.
export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await client().post<T>(`/rpc/${fn}`, args);
  return res.data;
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
  tenants:             ['id', 'slug', 'name', 'plan', 'status', 'created_at', 'updated_at'],
  tenant_configs:      ['tenant_id', 'config', 'updated_by', 'updated_at'],
  adapter_credentials: ['tenant_id', 'ciphertext', 'iv', 'algorithm', 'updated_at'],
  platform_users:      ['tenant_id', 'email', 'password_hash', 'role', 'created_at', 'last_login_at'],
  audit_log:           ['id', 'tenant_id', 'actor', 'action', 'details', 'created_at'],
  // Paddle mirror (migrations/008_billing_paddle.sql). Drift here is worse than
  // elsewhere: these rows are the only local record of what a customer is
  // entitled to, and a failed write means a paid customer silently loses access.
  billing_customers:     ['customer_id', 'tenant_id', 'email', 'status', 'created_at', 'updated_at'],
  billing_subscriptions: ['subscription_id', 'customer_id', 'tenant_id', 'status', 'price_id',
                          'product_id', 'items', 'scheduled_change_action', 'scheduled_change_at',
                          'current_period_ends_at', 'last_event_at', 'created_at', 'updated_at'],
  billing_transactions:  ['transaction_id', 'customer_id', 'subscription_id', 'tenant_id',
                          'status', 'currency_code', 'total', 'billed_at'],
  billing_webhook_events: ['event_id', 'event_type', 'occurred_at', 'processed_at'],
  // POS ledger (migrations 004/005/007/009). Every channel now writes orders
  // here, so drift on these tables loses sales rather than log lines — the
  // loudest possible reason to check them at boot.
  //
  // `orders` is SHARED with the FastAPI backend: these are the columns WE write,
  // not the full table. `payment_ref` and `instructions` in particular exist only
  // because migration 009 added them — migration 002 tried to `create table if
  // not exists orders` against a table that already had a different shape, which
  // added nothing at all.
  orders:       ['id', 'tenant_id', 'order_number', 'status', 'order_type', 'source',
                 'customer_name', 'customer_phone', 'subtotal', 'discount', 'delivery_fee',
                 'tax_total', 'service_charge', 'total_amount', 'payment_method',
                 'payment_status', 'payment_ref', 'instructions', 'notes',
                 'table_id', 'shift_id', 'staff_id', 'customer_id',
                 'opened_at', 'closed_at', 'voided_at', 'void_reason',
                 'created_at', 'updated_at'],
  order_items:  ['id', 'tenant_id', 'order_id', 'dish_id', 'dish_name', 'quantity',
                 'unit_price', 'item_total', 'line_discount', 'selected_options',
                 'notes', 'seat_no', 'course', 'voided_at', 'void_reason'],
  venue_tables: ['id', 'tenant_id', 'area', 'label', 'seats', 'x', 'y', 'status'],
  pos_payments: ['id', 'tenant_id', 'order_id', 'shift_id', 'method', 'amount',
                 'tendered', 'change_due', 'tip', 'status', 'refunded_amount',
                 'reference', 'staff_id', 'created_at'],
  pos_shifts:   ['id', 'tenant_id', 'opened_by', 'opened_at', 'opening_float',
                 'closed_by', 'closed_at', 'declared_cash', 'expected_cash',
                 'variance', 'note', 'status'],
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
