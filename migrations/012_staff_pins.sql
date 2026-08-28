-- ============================================================
-- Phase POS-6: terminal PIN login and granular POS permissions
-- Run this in: Supabase SQL Editor -> New Query -> Run
-- Depends on: 001_tenants.sql (platform_users)
-- ============================================================
--
-- A shared till stays logged in as the tenant for a whole shift. The PIN
-- identifies the OPERATOR for each privileged action -- whose staff_id lands on
-- the order, who authorised the void, who counted the drawer. It is not a
-- second password and must never be treated as one: it grants no session and
-- cannot reach anything the terminal's own token could not already reach.
--
-- pin_hash is scrypt (N=16384, r=8, p=1) with a per-user random salt, stored as
--   scrypt$N$r$p$saltHex$hashHex
-- See src/lib/pin.ts. Deliberately NOT sha256: a 4-digit PIN is 10,000
-- possibilities, which a fast hash exhausts instantly if the column ever leaks.
-- platform_users.password_hash is sha256 today; that is a separate pre-existing
-- weakness and is not widened to here.

alter table public.platform_users add column if not exists pin_hash   text;
alter table public.platform_users add column if not exists pin_set_at timestamptz;

-- Per-user POS capabilities. jsonb rather than columns because this set grows
-- with the POS (comp, price override, refund limits) and each addition would
-- otherwise be a migration plus a deploy.
--
-- Empty object = no privileges. Absent keys read as false everywhere, so the
-- default is fail-closed: a capability is held only when explicitly granted.
alter table public.platform_users
  add column if not exists pos_permissions jsonb not null default '{}'::jsonb;

-- PIN lookup is "find the user in THIS tenant whose PIN matches", so every
-- candidate row for a tenant is read on each attempt.
create index if not exists platform_users_tenant_pin_idx
  on public.platform_users (tenant_id) where pin_hash is not null;

-- A PIN is only unique within a restaurant, never globally.
create unique index if not exists platform_users_tenant_pin_uidx
  on public.platform_users (tenant_id, pin_hash) where pin_hash is not null;

notify pgrst, 'reload schema';
