-- ============================================================
-- Phase RES-1: Reservations module
-- Run this in: Supabase SQL Editor → New Query → Run
-- Depends on: 005_pos_core.sql (venue_tables)
-- ============================================================
--
-- This module is sold standalone. Nothing here references any pos_* table:
-- a bookings-only tenant gets venue_tables + res_* and nothing else. The only
-- link to the POS is application-level (`POST /api/reservations/:id/seat`,
-- which is feature-gated and fails closed).
--
-- btree_gist lets a GiST exclusion constraint mix an equality column (table_id)
-- with a range column (the booking window). Without it the `=` operator on uuid
-- is not GiST-indexable and the constraint below cannot be created.
create extension if not exists btree_gist;

-- ── res_reservations ─────────────────────────────────────────────────────────
-- `duration_min` rather than an explicit end time: staff think in "90 minutes",
-- and turn time is a per-tenant policy that changes. The materialised window is
-- derived from it in res_reservation_tables below.
create table if not exists public.res_reservations (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  customer_id    uuid references public.pos_customers(id) on delete set null,
  guest_name     text not null,
  guest_phone    text,
  guest_email    text,
  party_size     integer not null check (party_size > 0),
  starts_at      timestamptz not null,
  duration_min   integer not null default 90 check (duration_min > 0),
  status         text not null default 'booked'
                   check (status in ('booked','confirmed','seated','completed','no_show','cancelled')),
  source         text not null default 'staff'
                   check (source in ('staff','voice','web','phone','walk_in')),
  notes          text,
  deposit_amount numeric(12,2) not null default 0,
  order_id       uuid references public.orders(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists res_reservations_tenant_time_idx
  on public.res_reservations (tenant_id, starts_at);
create index if not exists res_reservations_status_idx
  on public.res_reservations (tenant_id, status);

-- ── res_reservation_tables ───────────────────────────────────────────────────
-- M:N so a party of 12 can occupy three joined tables.
--
-- `during` and `blocks` are denormalised from the parent reservation on
-- purpose. They exist so the exclusion constraint below can do its job: a
-- constraint can only see columns on its own row, and double-booking must be
-- rejected by the DATABASE, not by an application check. Two staff members
-- booking the last table at the same instant will both pass an app-level
-- "is it free?" query — one of them has to lose at commit time, and only a
-- constraint can make that happen.
--
-- `blocks` is false for cancelled/no-show reservations so a cancellation
-- immediately frees the slot without deleting the history.
--
-- Both columns are maintained by the trigger below. Never write them by hand.
create table if not exists public.res_reservation_tables (
  reservation_id uuid not null references public.res_reservations(id) on delete cascade,
  table_id       uuid not null references public.venue_tables(id)     on delete cascade,
  during         tstzrange not null,
  blocks         boolean   not null default true,
  primary key (reservation_id, table_id),
  constraint res_no_double_booking
    exclude using gist (table_id with =, during with &&) where (blocks)
);

create index if not exists res_reservation_tables_table_idx
  on public.res_reservation_tables (table_id);

-- Keep `during` / `blocks` in step with the parent whenever a booking is
-- rescheduled, shortened, cancelled or reinstated.
create or replace function public.res_sync_reservation_tables() returns trigger as $$
begin
  update public.res_reservation_tables t
     set during = tstzrange(new.starts_at,
                            new.starts_at + make_interval(mins => new.duration_min),
                            '[)'),
         blocks = new.status not in ('cancelled','no_show','completed')
   where t.reservation_id = new.id;
  return new;
end;
$$ language plpgsql;

drop trigger if exists res_reservations_sync_tables on public.res_reservations;
create trigger res_reservations_sync_tables
  after update of starts_at, duration_min, status on public.res_reservations
  for each row execute function public.res_sync_reservation_tables();

-- ── res_service_periods ──────────────────────────────────────────────────────
-- Opening hours per weekday, with an optional covers ceiling so a kitchen can
-- cap how many guests it accepts in one service regardless of free tables.
-- weekday: 0 = Sunday … 6 = Saturday (matches JS getDay()).
create table if not exists public.res_service_periods (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  weekday    smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time   time not null,
  max_covers integer,
  active     boolean not null default true,
  check (end_time > start_time)
);

create index if not exists res_service_periods_tenant_idx
  on public.res_service_periods (tenant_id, weekday);

-- ── res_blackouts ────────────────────────────────────────────────────────────
-- Holidays, private hire, refurbishment. Availability subtracts these.
create table if not exists public.res_blackouts (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  reason     text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index if not exists res_blackouts_tenant_idx
  on public.res_blackouts (tenant_id, starts_at);

-- ── res_waitlist ─────────────────────────────────────────────────────────────
create table if not exists public.res_waitlist (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,
  phone           text,
  party_size      integer not null check (party_size > 0),
  quoted_wait_min integer,
  status          text not null default 'waiting'
                    check (status in ('waiting','notified','seated','left','cancelled')),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists res_waitlist_tenant_idx
  on public.res_waitlist (tenant_id, status, created_at);

-- ── Row-level security ───────────────────────────────────────────────────────
alter table public.res_reservations       enable row level security;
alter table public.res_reservation_tables enable row level security;
alter table public.res_service_periods    enable row level security;
alter table public.res_blackouts          enable row level security;
alter table public.res_waitlist           enable row level security;

drop policy if exists res_reservations_isolation on public.res_reservations;
create policy res_reservations_isolation on public.res_reservations
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

drop policy if exists res_service_periods_isolation on public.res_service_periods;
create policy res_service_periods_isolation on public.res_service_periods
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

drop policy if exists res_blackouts_isolation on public.res_blackouts;
create policy res_blackouts_isolation on public.res_blackouts
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

drop policy if exists res_waitlist_isolation on public.res_waitlist;
create policy res_waitlist_isolation on public.res_waitlist
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

-- Join table carries no tenant_id of its own; isolate it through its parent.
drop policy if exists res_reservation_tables_isolation on public.res_reservation_tables;
create policy res_reservation_tables_isolation on public.res_reservation_tables
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or exists (
      select 1 from public.res_reservations r
       where r.id = res_reservation_tables.reservation_id
         and r.tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
    )
  );

-- ── updated_at triggers ──────────────────────────────────────────────────────
drop trigger if exists res_reservations_touch_updated on public.res_reservations;
create trigger res_reservations_touch_updated before update on public.res_reservations
  for each row execute function public.touch_updated_at();

drop trigger if exists res_waitlist_touch_updated on public.res_waitlist;
create trigger res_waitlist_touch_updated before update on public.res_waitlist
  for each row execute function public.touch_updated_at();

notify pgrst, 'reload schema';
