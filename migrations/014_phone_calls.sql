-- ============================================================
-- Phase PHONE-1: inbound call records
-- Run this in: Supabase SQL Editor -> New Query -> Run
-- Depends on: 001_tenants.sql, 004_pos_orders_extend.sql
-- ============================================================
--
-- One row per call the agent answers. This is what makes "why did this order
-- say three biryanis" answerable, and what tells you whether the phone channel
-- is worth its trunk minutes.
--
-- The caller's number is stored in full because a restaurant genuinely needs to
-- ring someone back about their delivery. It is masked to the last 4 digits in
-- logs -- see maskNumber() in telephony/callRepo.ts.

create table if not exists public.pos_calls (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  direction    text not null default 'inbound' check (direction in ('inbound','outbound')),

  -- E.164 where the trunk provides it. Nullable because Pakistani trunks do not
  -- reliably deliver CLI, which is exactly why the phone prompt tells the agent
  -- to ASK for a callback number rather than assume it has one.
  from_number  text,
  to_did       text,

  -- The channel id Asterisk gave this call. Correlates our record with the
  -- provider's CDR when a line item on the trunk bill needs explaining.
  channel_ref  text,

  started_at   timestamptz not null default now(),
  answered_at  timestamptz,
  ended_at     timestamptz,
  duration_s   integer,

  outcome      text not null default 'in_progress'
                 check (outcome in ('in_progress','ordered','enquiry','abandoned','transferred','failed')),
  order_id     uuid references public.orders(id) on delete set null,

  -- Turn-by-turn text of what was said. jsonb rather than a child table: it is
  -- read whole or not at all, and never queried across calls.
  transcript   jsonb not null default '[]'::jsonb,
  error        text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists pos_calls_tenant_time_idx on public.pos_calls (tenant_id, started_at desc);
create index if not exists pos_calls_outcome_idx     on public.pos_calls (tenant_id, outcome);
create index if not exists pos_calls_order_idx       on public.pos_calls (order_id) where order_id is not null;

alter table public.pos_calls enable row level security;

drop policy if exists pos_calls_isolation on public.pos_calls;
create policy pos_calls_isolation on public.pos_calls
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

drop trigger if exists pos_calls_touch_updated on public.pos_calls;
create trigger pos_calls_touch_updated before update on public.pos_calls
  for each row execute function public.touch_updated_at();

notify pgrst, 'reload schema';
