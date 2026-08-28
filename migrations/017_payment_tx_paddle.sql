-- ─────────────────────────────────────────────────────────────────────────────
-- payment_transactions: create it, and allow 'paddle'.
--
-- Diner card payments were persisted ONLY to Redis under `payment:<ref>` with a
-- 30-day TTL, so the record of a customer's card payment deleted itself a month
-- after they made it. This migration provisions the durable target that
-- src/lib/paymentStore.ts now writes.
--
-- WHY THIS DOES NOT JUST RUN migrations/002_payments.sql
--
-- 002 was written to create these tables and was never applied — verified against
-- the live database, where neither payment_transactions nor payment_ledger
-- exists. Running it now would be the obvious move and is the wrong one, because
-- 002 also does this to the SHARED orders table:
--
--     create table if not exists public.orders (...)   -- silent no-op; the
--                                                      -- FastAPI table already
--                                                      -- exists with a different
--                                                      -- shape. This is how
--                                                      -- payment_ref and
--                                                      -- instructions came to be
--                                                      -- missing until 009.
--     alter table public.orders enable row level security;
--     create policy orders_isolation on public.orders ...
--     create trigger orders_touch_updated before update on public.orders ...
--
-- Enabling RLS on orders is a behaviour change on a table the FastAPI service
-- reads and writes, and that service has a documented silent fallback to the
-- anon key when its service-role key is absent. Under that fallback, RLS on
-- orders takes its order flow offline. Nothing about persisting payments
-- requires touching orders at all, so this migration does not.
--
-- Shapes below match 002 exactly, so an environment where 002 WAS applied
-- converges on the same schema rather than diverging from it.
--
-- Money is integer paisa (bigint), never float. NEVER stores PAN / card / EMV
-- data — only the gateway's reference and the outcome, which is all that
-- reconciling against a settlement file needs.
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;

create table if not exists public.payment_transactions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  -- on delete set null, not cascade: a payment record has to outlive its order.
  -- Reconciliation against a settlement file happens long after an order may
  -- have been purged, and losing the payment row is the failure this table
  -- exists to prevent.
  order_id        uuid references public.orders(id) on delete set null,
  provider        text not null,
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

-- Applied separately from the create so it also corrects a database where 002
-- ran first: 002's provider list predates Paddle, which is the provider that
-- actually takes diner card money here, so every insert would fail the check.
alter table public.payment_transactions
  drop constraint if exists payment_transactions_provider_check;

alter table public.payment_transactions
  add constraint payment_transactions_provider_check
  check (provider in ('cash','safepay','paddle','paymob','bank_ipg','pos_passthrough'));

-- One row per gateway reference. This is what makes the write path idempotent:
-- paymentStore.savePaymentTxn upserts on it, so a retried checkout or a
-- redelivered webhook converges on one row instead of stacking attempts.
create unique index if not exists payment_tx_provider_ref_idx
  on public.payment_transactions (provider, provider_ref);
create index if not exists payment_tx_tenant_time_idx
  on public.payment_transactions (tenant_id, created_at desc);
create index if not exists payment_tx_order_idx
  on public.payment_transactions (order_id);

-- Append-only double-entry journal for reconciliation. Nothing writes it yet —
-- created here so the pair stays together and 002 has no remaining reason to be
-- run against this database.
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

create index if not exists payment_ledger_tenant_time_idx
  on public.payment_ledger (tenant_id, created_at desc);

-- RLS on these two tables only — both are new and written solely by this
-- service, so enabling it cannot surprise anyone. The service-role key bypasses
-- it; the policies matter the day this moves to anon + per-request JWT.
alter table public.payment_transactions enable row level security;
alter table public.payment_ledger       enable row level security;

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

-- public.touch_updated_at() already exists — migration 005 applied cleanly and
-- uses it on venue_tables.
drop trigger if exists payment_tx_touch_updated on public.payment_transactions;
create trigger payment_tx_touch_updated before update on public.payment_transactions
  for each row execute function public.touch_updated_at();
