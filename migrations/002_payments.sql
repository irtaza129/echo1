-- ─────────────────────────────────────────────────────────────────────────────
-- Payments — durable ledger (Supabase / Postgres)
--
-- Runtime today persists orders + payment transactions in Redis (hot path),
-- mirroring how local orders already work. This migration provisions the
-- durable target so payment records survive Redis eviction and can be
-- reconciled against gateway settlement files.
--
-- Idempotent: every object uses `if not exists`. Money is integer paisa
-- (bigint) — never float. Currency is PKR for the Pakistan market.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;

-- ── orders ───────────────────────────────────────────────────────────────────
-- Promotes the Redis order to a durable row. order_number is per-tenant.
create table if not exists public.orders (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  order_number    bigint not null,
  status          text not null default 'pending',
  subtotal_paisa  bigint not null default 0,
  gst_paisa       bigint not null default 0,
  total_paisa     bigint not null default 0,
  currency        text not null default 'PKR',
  payment_status  text not null default 'unpaid'
                    check (payment_status in
                      ('unpaid','initiated','authorized','captured','failed','cancelled','refunded')),
  customer_name   text,
  customer_phone  text,
  order_type      text not null default 'dine_in',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists orders_tenant_time_idx on public.orders (tenant_id, created_at desc);

-- ── payment_transactions ─────────────────────────────────────────────────────
-- Append-mostly. One row per payment attempt. NEVER stores PAN / card / EMV data
-- — only the gateway's reference and outcome. raw_response is PAN-scrubbed JSON.
create table if not exists public.payment_transactions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  order_id        uuid references public.orders(id) on delete set null,
  provider        text not null
                    check (provider in ('cash','safepay','paymob','bank_ipg','pos_passthrough')),
  provider_ref    text not null,
  amount_paisa    bigint not null,
  currency        text not null default 'PKR',
  status          text not null
                    check (status in
                      ('initiated','authorized','captured','failed','cancelled','refunded')),
  method          text not null default 'card'
                    check (method in ('cash','card','wallet','raast','tap_to_pay')),
  threeds_status  text,
  auth_code       text,
  rrn             text,
  raw_response    jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One transaction per gateway reference — also the idempotency guard for webhooks.
create unique index if not exists payment_tx_provider_ref_idx on public.payment_transactions (provider, provider_ref);
create index if not exists payment_tx_tenant_time_idx on public.payment_transactions (tenant_id, created_at desc);
create index if not exists payment_tx_order_idx on public.payment_transactions (order_id);

-- ── payment_ledger ───────────────────────────────────────────────────────────
-- Append-only double-entry journal for reconciliation against settlement files.
create table if not exists public.payment_ledger (
  id              bigserial primary key,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  transaction_id  uuid references public.payment_transactions(id) on delete set null,
  direction       text not null check (direction in ('debit','credit')),
  amount_paisa    bigint not null,
  currency        text not null default 'PKR',
  memo            text,
  created_at      timestamptz not null default now()
);

create index if not exists payment_ledger_tenant_time_idx on public.payment_ledger (tenant_id, created_at desc);

-- ── RLS (mirrors db/schema.sql — service-role bypasses; activates with anon JWT)
alter table public.orders               enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.payment_ledger       enable row level security;

drop policy if exists orders_isolation on public.orders;
create policy orders_isolation on public.orders
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

drop policy if exists payment_tx_isolation on public.payment_transactions;
create policy payment_tx_isolation on public.payment_transactions
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

drop policy if exists payment_ledger_isolation on public.payment_ledger;
create policy payment_ledger_isolation on public.payment_ledger
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

-- updated_at triggers (function defined in db/schema.sql)
drop trigger if exists orders_touch_updated on public.orders;
create trigger orders_touch_updated before update on public.orders
  for each row execute function public.touch_updated_at();

drop trigger if exists payment_tx_touch_updated on public.payment_transactions;
create trigger payment_tx_touch_updated before update on public.payment_transactions
  for each row execute function public.touch_updated_at();
