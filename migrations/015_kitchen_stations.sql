-- ============================================================
-- Phase KDS-1: kitchen stations and per-line ticket state
-- Run this in: Supabase SQL Editor -> New Query -> Run
-- Depends on: 004_pos_orders_extend.sql
-- ============================================================
--
-- A kitchen is not one queue. The grill, the fryer and the drinks counter each
-- want to see only their own lines, and they finish at different times -- which
-- is why "the order is ready" is a different question from "this station's part
-- of the order is ready".

create table if not exists public.pos_stations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  -- Lower sorts first. Used for tab order on the expo screen.
  sort_order integer not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create index if not exists pos_stations_tenant_idx on public.pos_stations (tenant_id, sort_order);

-- Which station cooks this dish. Nullable and additive: a tenant with no
-- stations configured sees every line on one board, which is the correct
-- behaviour for a small kitchen and makes this opt-in.
alter table public.dishes add column if not exists station_id uuid;

-- Deliberately NO foreign key. `dishes` is the FastAPI backend's table, and a
-- constraint pointing from their table into ours would make deleting one of our
-- stations fail inside their code with an error they cannot interpret. An
-- orphaned id reads as "no station", which is the safe default.
create index if not exists dishes_station_idx on public.dishes (station_id) where station_id is not null;

-- ── Ticket state, per LINE ──────────────────────────────────────────────────
-- Bumping is per line, not per order: the drinks are ready long before the
-- karahi, and a board that can only bump whole orders forces the kitchen to
-- either lie or wait.
--
-- started_at is when the station accepted the line. The gap between that and
-- created_at is how long a ticket sat unclaimed, which is the number that tells
-- a manager the kitchen is underwater.
alter table public.order_items add column if not exists started_at timestamptz;
alter table public.order_items add column if not exists bumped_at  timestamptz;
alter table public.order_items add column if not exists bumped_by  uuid;

-- The KDS reads "unbumped lines for this tenant". Partial so the index stays
-- small -- a day's bumped tickets are not interesting to it.
create index if not exists order_items_kds_idx
  on public.order_items (tenant_id, order_id)
  where bumped_at is null and voided_at is null;

alter table public.pos_stations enable row level security;

drop policy if exists pos_stations_isolation on public.pos_stations;
create policy pos_stations_isolation on public.pos_stations
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

notify pgrst, 'reload schema';
