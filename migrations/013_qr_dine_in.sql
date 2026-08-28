-- ============================================================
-- Phase QR-1: dine-in self-ordering from a QR code at the table
-- Run this in: Supabase SQL Editor -> New Query -> Run
-- Depends on: 005_pos_core.sql (venue_tables)
-- ============================================================
--
-- Auth model: the QR encodes /t/<tenant-slug>/<qr_token>. The token is a random
-- opaque id -- NOT the table's uuid and NOT its number, both of which are
-- guessable and would let anyone order to any table by editing the URL.
--
-- The PIN is printed on the table card, never encoded in the QR. That is the
-- whole point of the pair: a photographed QR is useless from the car park, and
-- a leaked PIN is rotated without reprinting anything.

alter table public.venue_tables add column if not exists qr_token       text;
alter table public.venue_tables add column if not exists pin_hash       text;
alter table public.venue_tables add column if not exists pin_rotated_at timestamptz;

-- Globally unique, not per tenant: it is the sole lookup key coming off a URL,
-- and a collision across tenants would resolve a diner to the wrong restaurant.
create unique index if not exists venue_tables_qr_token_uidx
  on public.venue_tables (qr_token) where qr_token is not null;

-- ── dine_sessions ───────────────────────────────────────────────────────────
-- One party's visit at one table. Scopes a guest's cart and orders, and gives
-- "table 6 has been sitting for 40 minutes" something to measure from.
--
-- Deliberately NOT tied to a device or a browser: a table of four scanning the
-- same QR should join the same session and build one shared cart, which is how
-- people actually order together.
create table if not exists public.dine_sessions (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id)      on delete cascade,
  table_id   uuid not null references public.venue_tables(id) on delete cascade,
  opened_at  timestamptz not null default now(),
  closed_at  timestamptz,
  guest_name text,
  status     text not null default 'open'
               check (status in ('open','closed','abandoned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists dine_sessions_tenant_idx on public.dine_sessions (tenant_id, opened_at desc);

-- At most one open session per table. Two live sessions on one table means two
-- carts and two bills for one group of people, and no way to tell which is real.
create unique index if not exists dine_sessions_one_open_per_table_uidx
  on public.dine_sessions (table_id) where status = 'open';

alter table public.orders add column if not exists dine_session_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_dine_session_id_fkey') then
    alter table public.orders
      add constraint orders_dine_session_id_fkey
      foreign key (dine_session_id) references public.dine_sessions(id) on delete set null;
  end if;
end $$;

-- ── service_requests ────────────────────────────────────────────────────────
-- "Call waiter", "bring the bill", "we need water". These pop on the cashier's
-- screen with the table number, which is the whole reason the guest app exists
-- alongside voice ordering.
--
-- Resolved requests are kept, not deleted: how long a table waited for someone
-- to come over is a real service metric, and it only exists if the rows survive.
create table if not exists public.service_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id)      on delete cascade,
  table_id        uuid not null references public.venue_tables(id) on delete cascade,
  dine_session_id uuid references public.dine_sessions(id) on delete set null,
  type            text not null default 'call_waiter'
                    check (type in ('call_waiter','request_bill','water','assistance')),
  note            text,
  status          text not null default 'open'
                    check (status in ('open','acknowledged','resolved')),
  created_at      timestamptz not null default now(),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  resolved_at     timestamptz
);

-- The cashier's alert list reads exactly this: open requests, oldest first.
create index if not exists service_requests_open_idx
  on public.service_requests (tenant_id, created_at)
  where status <> 'resolved';

create index if not exists service_requests_table_idx on public.service_requests (table_id, created_at desc);

alter table public.dine_sessions    enable row level security;
alter table public.service_requests enable row level security;

drop policy if exists dine_sessions_isolation on public.dine_sessions;
create policy dine_sessions_isolation on public.dine_sessions
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

drop policy if exists service_requests_isolation on public.service_requests;
create policy service_requests_isolation on public.service_requests
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

drop trigger if exists dine_sessions_touch_updated on public.dine_sessions;
create trigger dine_sessions_touch_updated before update on public.dine_sessions
  for each row execute function public.touch_updated_at();

notify pgrst, 'reload schema';
