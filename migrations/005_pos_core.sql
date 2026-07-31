-- ============================================================
-- Phase POS-1: Core point-of-sale tables
-- Run this in: Supabase SQL Editor → New Query → Run
-- Depends on: 004_pos_orders_extend.sql
-- ============================================================
--
-- Naming: every table here is prefixed (`pos_*`, `venue_*`) because this
-- Supabase project is shared with the FastAPI backend, which already owns
-- unprefixed `orders`, `order_items`, `menu_items`, `dishes`, `categories`,
-- `dish_options`, `dish_sub_options`. An unprefixed `payments` or `customers`
-- today is a collision waiting for whenever FastAPI adds its own. The prefix
-- costs nothing and removes the whole failure class.
--
-- Money is `numeric(12,2)` everywhere — never float. Binary floating point
-- cannot represent 0.10, and a POS that drifts by a cent per line is a POS
-- whose Z-report never balances.

-- ── venue_tables ─────────────────────────────────────────────────────────────
-- The floor plan. SHARED between the POS and Reservations modules — this is the
-- single coupling point between the two products. A reservations-only tenant
-- uses these rows and never touches any pos_* table; a POS-only tenant uses
-- them for dine-in tabs and never touches any res_* table.
--
-- x/y are free-form canvas coordinates for the drag-to-arrange floor map. They
-- are presentation state, deliberately stored server-side so the layout follows
-- the tenant across terminals rather than living in one browser's localStorage.
create table if not exists public.venue_tables (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  area       text not null default 'Main',
  label      text not null,
  seats      integer not null default 2 check (seats > 0),
  x          integer not null default 0,
  y          integer not null default 0,
  status     text not null default 'available'
               check (status in ('available','occupied','reserved','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, area, label)
);

create index if not exists venue_tables_tenant_idx on public.venue_tables (tenant_id);

-- ── pos_customers ────────────────────────────────────────────────────────────
-- Phone is the lookup key at the till ("what's your number?"). Unique per
-- tenant so repeat customers merge instead of duplicating, but nullable because
-- a walk-in cash sale has no customer at all.
create table if not exists public.pos_customers (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text,
  phone      text,
  email      text,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists pos_customers_tenant_phone_uidx
  on public.pos_customers (tenant_id, phone) where phone is not null;
create index if not exists pos_customers_tenant_idx on public.pos_customers (tenant_id);

-- ── pos_shifts ───────────────────────────────────────────────────────────────
-- A cash drawer session. This is the table that separates a POS from an
-- order-taking app: without it there is no answer to "is the till correct?".
--
-- expected_cash is computed at close (opening_float + cash sales + cash in
-- - cash out - cash refunds) and stored, not recomputed on read — the menu
-- prices and payment rows behind it can change, but what the drawer was
-- expected to hold at 11pm on a given night must never change afterwards.
create table if not exists public.pos_shifts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  opened_by     uuid,
  opened_at     timestamptz not null default now(),
  opening_float numeric(12,2) not null default 0,
  closed_by     uuid,
  closed_at     timestamptz,
  declared_cash numeric(12,2),
  expected_cash numeric(12,2),
  variance      numeric(12,2),
  note          text,
  status        text not null default 'open' check (status in ('open','closed'))
);

create index if not exists pos_shifts_tenant_idx on public.pos_shifts (tenant_id, opened_at desc);

-- At most one open shift per tenant. Enforced here rather than in the route:
-- two concurrently-open drawers make every cash figure ambiguous, and a
-- race between two managers clicking "Open shift" would otherwise slip through.
create unique index if not exists pos_shifts_one_open_per_tenant_uidx
  on public.pos_shifts (tenant_id) where status = 'open';

-- ── pos_cash_movements ───────────────────────────────────────────────────────
-- Paid-in / paid-out / drop / pickup. Every non-sale movement of cash must be
-- recorded or the variance at close is meaningless.
create table if not exists public.pos_cash_movements (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  shift_id   uuid not null references public.pos_shifts(id) on delete cascade,
  type       text not null check (type in ('cash_in','cash_out','drop','pickup')),
  amount     numeric(12,2) not null check (amount > 0),
  reason     text,
  staff_id   uuid,
  created_at timestamptz not null default now()
);

create index if not exists pos_cash_movements_shift_idx on public.pos_cash_movements (shift_id);

-- ── pos_payments ─────────────────────────────────────────────────────────────
-- One row per tender. An order with a split payment has several rows; this is
-- why payment cannot live as columns on `orders` (the existing
-- orders.payment_method / payment_status stay for FastAPI's single-tender
-- flow and are left untouched).
--
-- tendered/change_due are stored rather than derived: for cash they are what
-- was physically handed over and returned, and re-deriving them later from
-- amount alone loses the drawer audit.
--
-- Refunds are recorded by incrementing refunded_amount, never by deleting or
-- negating the original row — the original sale must remain visible in the
-- Z-report that already closed.
create table if not exists public.pos_payments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  order_id        uuid not null references public.orders(id) on delete cascade,
  shift_id        uuid references public.pos_shifts(id) on delete set null,
  method          text not null check (method in ('cash','card','wallet','bank','voucher','other')),
  amount          numeric(12,2) not null check (amount > 0),
  tendered        numeric(12,2),
  change_due      numeric(12,2) not null default 0,
  tip             numeric(12,2) not null default 0,
  status          text not null default 'captured'
                    check (status in ('captured','voided','refunded','partially_refunded')),
  refunded_amount numeric(12,2) not null default 0 check (refunded_amount >= 0),
  reference       text,
  staff_id        uuid,
  created_at      timestamptz not null default now(),
  constraint pos_payments_refund_within_amount check (refunded_amount <= amount)
);

create index if not exists pos_payments_order_idx  on public.pos_payments (order_id);
create index if not exists pos_payments_tenant_idx on public.pos_payments (tenant_id, created_at desc);
create index if not exists pos_payments_shift_idx  on public.pos_payments (shift_id) where shift_id is not null;

-- ── Wire up the FKs that 004 could not add yet ───────────────────────────────
-- 004 added orders.table_id / shift_id as bare uuids because the referenced
-- tables did not exist yet. Add the constraints now, guarded so re-running is
-- safe (Postgres has no `add constraint if not exists`).
alter table public.orders add column if not exists customer_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_table_id_fkey') then
    alter table public.orders
      add constraint orders_table_id_fkey
      foreign key (table_id) references public.venue_tables(id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'orders_shift_id_fkey') then
    alter table public.orders
      add constraint orders_shift_id_fkey
      foreign key (shift_id) references public.pos_shifts(id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'orders_customer_id_fkey') then
    alter table public.orders
      add constraint orders_customer_id_fkey
      foreign key (customer_id) references public.pos_customers(id) on delete set null;
  end if;
end $$;

-- ── Row-level security ───────────────────────────────────────────────────────
-- Same pattern as db/schema.sql: the service-role key the app uses bypasses
-- these, so they change nothing today. They exist so that moving to anon +
-- per-request JWT later is a config change rather than a schema rewrite.
alter table public.venue_tables       enable row level security;
alter table public.pos_customers      enable row level security;
alter table public.pos_shifts         enable row level security;
alter table public.pos_cash_movements enable row level security;
alter table public.pos_payments       enable row level security;

drop policy if exists venue_tables_isolation on public.venue_tables;
create policy venue_tables_isolation on public.venue_tables
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

drop policy if exists pos_customers_isolation on public.pos_customers;
create policy pos_customers_isolation on public.pos_customers
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

drop policy if exists pos_shifts_isolation on public.pos_shifts;
create policy pos_shifts_isolation on public.pos_shifts
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

drop policy if exists pos_cash_movements_isolation on public.pos_cash_movements;
create policy pos_cash_movements_isolation on public.pos_cash_movements
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

drop policy if exists pos_payments_isolation on public.pos_payments;
create policy pos_payments_isolation on public.pos_payments
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

-- ── updated_at triggers ──────────────────────────────────────────────────────
-- public.touch_updated_at() is defined in db/schema.sql.
drop trigger if exists venue_tables_touch_updated on public.venue_tables;
create trigger venue_tables_touch_updated before update on public.venue_tables
  for each row execute function public.touch_updated_at();

drop trigger if exists pos_customers_touch_updated on public.pos_customers;
create trigger pos_customers_touch_updated before update on public.pos_customers
  for each row execute function public.touch_updated_at();

notify pgrst, 'reload schema';
