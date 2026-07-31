-- ============================================================
-- Phase POS-0: Extend the shared orders schema for point-of-sale
-- Run this in: Supabase SQL Editor → New Query → Run
-- ============================================================
--
-- Why this is `alter table`, not `create table`
-- ---------------------------------------------
-- This Supabase project is SHARED with the FastAPI/Render backend. It already
-- owns tenant-scoped `orders`, `order_items`, `categories`, `dishes`,
-- `dish_options` and `dish_sub_options`, plus the `v_menu` / `v_order_summary`
-- views built on them.
--
-- `create table if not exists orders (...)` against an existing table with a
-- DIFFERENT shape is a no-op — it never adds a column. Every POS insert would
-- then fail with PGRST204, and (per migrations/002) that failure class has
-- already cost this project a silently-dead audit trail. Doing it to `orders`
-- would silently lose sales.
--
-- So the POS ADOPTS the existing tables and adds only what it needs. The upside
-- is real: POS orders land in the same table the Render backend already reads,
-- so native-POS tenants and managed tenants converge on one order history
-- instead of drifting into two.
--
-- Everything below is additive and nullable — FastAPI keeps working untouched.

-- ── orders: POS columns ──────────────────────────────────────────────────────
-- order_number  : human receipt number, unique per tenant (see function below)
-- table_id      : dine-in table, FK added in 005 once venue_tables exists
-- staff_id      : who rang it in (platform_users.id)
-- shift_id      : which cash shift owns it, FK added in 005
-- tax_total     : GST as charged. Previously computed in the UI only and never
--                 stored; a POS must persist tax as sold for reconciliation.
-- service_charge: optional, separate from tip
-- opened_at     : when the tab opened (created_at is insert time; a tab may sit
--                 open for an hour before it closes)
-- voided_at     : voids NEVER delete rows — refunds and Z-reports must still see
--                 them. `status` alone is not enough because a void can happen
--                 from any status.
-- source        : 'pos' | 'kiosk' | 'voice' | 'phone' — needed to report on
--                 whether the AI kiosk is actually earning its keep.
alter table public.orders add column if not exists order_number   bigint;
alter table public.orders add column if not exists table_id       uuid;
alter table public.orders add column if not exists staff_id       uuid;
alter table public.orders add column if not exists shift_id       uuid;
alter table public.orders add column if not exists tax_total      numeric(12,2) not null default 0;
alter table public.orders add column if not exists service_charge numeric(12,2) not null default 0;
alter table public.orders add column if not exists opened_at      timestamptz;
alter table public.orders add column if not exists closed_at      timestamptz;
alter table public.orders add column if not exists voided_at      timestamptz;
alter table public.orders add column if not exists void_reason    text;
alter table public.orders add column if not exists source         text not null default 'kiosk';

-- Receipt numbers are unique per tenant, not globally. Partial index so the
-- thousands of existing FastAPI rows with a null order_number don't collide.
create unique index if not exists orders_tenant_number_uidx
  on public.orders (tenant_id, order_number)
  where order_number is not null;

create index if not exists orders_tenant_created_idx on public.orders (tenant_id, created_at desc);
create index if not exists orders_tenant_status_idx  on public.orders (tenant_id, status);
create index if not exists orders_shift_idx          on public.orders (shift_id) where shift_id is not null;
create index if not exists orders_table_open_idx     on public.orders (table_id)
  where table_id is not null and closed_at is null and voided_at is null;

-- ── order_items: POS columns ─────────────────────────────────────────────────
-- No `order_item_options` table is created: `order_items.selected_options` is
-- already jsonb and already holds the modifier snapshot as sold, and
-- `dish_name` already snapshots the name. Adding a normalised twin would give
-- us two sources of truth for the same fact.
--
-- line_discount : per-line discount as applied, so the receipt reprints exactly
-- seat_no       : which cover ordered it — this is what makes "split by seat"
--                 possible at all, and it must be captured at ring-in time
--                 because you cannot reconstruct it later.
alter table public.order_items add column if not exists line_discount numeric(12,2) not null default 0;
alter table public.order_items add column if not exists voided_at     timestamptz;
alter table public.order_items add column if not exists void_reason   text;
alter table public.order_items add column if not exists course        text;
alter table public.order_items add column if not exists seat_no       integer;

create index if not exists order_items_order_idx on public.order_items (order_id);

-- ── Atomic per-tenant receipt numbering ──────────────────────────────────────
-- Replaces `redis.incr(local:order:counter:<tenantId>)`, which is what makes
-- the current local path safe under concurrency. Two terminals ringing up at
-- the same moment MUST NOT mint the same receipt number.
--
-- `insert … on conflict do update … returning` is atomic in a single statement:
-- the row lock is held for the duration, so concurrent callers serialise and
-- each gets a distinct number. Do not "optimise" this into select-then-update.
create table if not exists public.pos_order_counters (
  tenant_id   uuid primary key references public.tenants(id) on delete cascade,
  last_number bigint not null default 0
);

create or replace function public.pos_next_order_number(p_tenant uuid)
returns bigint as $$
  insert into public.pos_order_counters (tenant_id, last_number)
       values (p_tenant, 1)
  on conflict (tenant_id)
    do update set last_number = public.pos_order_counters.last_number + 1
    returning last_number;
$$ language sql volatile;

-- Seed each tenant's counter above any receipt number already in use, so a
-- backfill of historical Redis orders can never be handed a number twice.
insert into public.pos_order_counters (tenant_id, last_number)
select tenant_id, coalesce(max(order_number), 0)
  from public.orders
 where tenant_id is not null
 group by tenant_id
on conflict (tenant_id) do update
  set last_number = greatest(public.pos_order_counters.last_number, excluded.last_number);

alter table public.pos_order_counters enable row level security;

drop policy if exists pos_order_counters_isolation on public.pos_order_counters;
create policy pos_order_counters_isolation on public.pos_order_counters
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

-- PostgREST caches the schema; force a reload so the new columns and the
-- pos_next_order_number RPC are visible immediately.
notify pgrst, 'reload schema';
