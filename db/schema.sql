-- ─────────────────────────────────────────────────────────────────────────────
-- Voice Kiosk Platform — Postgres schema (Supabase)
--
-- ⚠ REFERENCE ONLY — NOT THE SOURCE OF TRUTH. DO NOT RUN THIS ON A LIVE DB.
--
-- `migrations/` is canonical. This file is a flattened picture of what the
-- schema should look like once every migration has been applied; it is useful
-- for reading, diffing and onboarding, and for nothing else.
--
-- Why the split matters
-- ---------------------
-- This file and migrations/001 both defined audit_log, and they disagreed
-- (actor/details here vs actor_id/payload there). The live database followed
-- the migration, the application code followed this file, and every audit write
-- failed with PGRST204 for as long as the feature has existed.
--
-- Re-running this file would not have fixed it and cannot fix that class of
-- drift: `create table if not exists` is a no-op against a table that already
-- exists with a DIFFERENT shape. It never adds a missing column. "Idempotent"
-- is not "reconciling".
--
-- Rules
-- -----
-- 1. Schema changes go in a NEW numbered file in migrations/ — never by editing
--    this file and re-running it.
-- 2. After writing the migration, update this file to match, so it stays an
--    accurate flattened view.
-- 3. Column changes to an already-deployed table require an explicit
--    `alter table`; see migrations/002_audit_log_actor_details.sql.
--
-- Storage model: Postgres is the source of truth for platform metadata
-- (tenants, configs, credentials, users, audit). Redis remains as a hot cache
-- only — TTLs there are now cache-eviction signals, not data-loss risk.
--
-- RLS policies are written but ARE bypassed by the service-role key the app
-- uses today. Switching the app to anon + a session-scoped JWT later will
-- activate them — the policy SQL doesn't have to change.
-- ─────────────────────────────────────────────────────────────────────────────

-- Required for gen_random_uuid()
create extension if not exists pgcrypto;

-- ── tenants ──────────────────────────────────────────────────────────────────
-- Note: a `tenants` table may already exist on the FastAPI side. This DDL is
-- additive — if a column listed below is missing, run a one-off
-- `alter table tenants add column …` to reconcile rather than re-creating.
create table if not exists public.tenants (
  id                  uuid primary key,
  slug                text unique not null,
  name                text not null,
  plan                text not null default 'starter'
                        check (plan in ('starter','growth','enterprise')),
  status              text not null default 'active'
                        check (status in ('active','suspended','deleted')),
  stripe_customer_id  text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists tenants_slug_idx   on public.tenants (slug);
create index if not exists tenants_status_idx on public.tenants (status);

-- ── tenant_configs ───────────────────────────────────────────────────────────
-- Full TenantConfig (zod-validated in app) stored as JSONB so schema changes
-- don't require migrations. Versioning the row would be nice; deferred.
create table if not exists public.tenant_configs (
  tenant_id   uuid primary key references public.tenants(id) on delete cascade,
  config      jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- ── adapter_credentials ──────────────────────────────────────────────────────
-- AES-256-GCM ciphertext + IV (both hex). Auth tag is appended to ciphertext
-- by src/lib/crypto.ts — store the blob verbatim so decryptCredentials works
-- without translation.
create table if not exists public.adapter_credentials (
  tenant_id   uuid primary key references public.tenants(id) on delete cascade,
  ciphertext  text not null,
  iv          text not null,
  algorithm   text not null default 'aes-256-gcm',
  updated_at  timestamptz not null default now()
);

-- ── platform_users ───────────────────────────────────────────────────────────
-- Named `platform_users` (not `users`) to avoid colliding with Supabase's
-- reserved `auth.users`. Tenant admins, managers, staff. super_admin lives in
-- env vars, not here.
create table if not exists public.platform_users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references public.tenants(id) on delete cascade,
  email         text unique not null,
  password_hash text not null,
  role          text not null
                  check (role in ('tenant_admin','manager','staff','kiosk')),
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

create index if not exists platform_users_tenant_idx on public.platform_users (tenant_id);
create index if not exists platform_users_email_idx  on public.platform_users (lower(email));

-- ── audit_log ────────────────────────────────────────────────────────────────
-- Append-only. `actor` is an opaque string (email, "legacy-agent1101", "super")
-- so we don't need a FK that would break for super_admin / system actors.
create table if not exists public.audit_log (
  id          bigserial primary key,
  tenant_id   uuid,
  actor       text,
  action      text not null,
  details     text,
  created_at  timestamptz not null default now()
);

create index if not exists audit_log_tenant_time_idx on public.audit_log (tenant_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-level security
--
-- Service-role key bypasses RLS, so the app keeps working today. Policies
-- below activate the moment a request uses the anon key (e.g. when we move
-- to user-scoped JWTs). They read `app.current_tenant_id` set per-request:
--
--   set local app.current_tenant_id = '<uuid>';
--
-- super_admin bypasses by setting:
--
--   set local app.is_super_admin = 'true';
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.tenants            enable row level security;
alter table public.tenant_configs     enable row level security;
alter table public.adapter_credentials enable row level security;
alter table public.platform_users     enable row level security;
alter table public.audit_log          enable row level security;

-- Helper expression — repeated below; not a function so it stays inlined.
-- (current_setting(..., true) returns '' instead of erroring when unset.)

drop policy if exists tenants_isolation on public.tenants;
create policy tenants_isolation on public.tenants
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

drop policy if exists tenant_configs_isolation on public.tenant_configs;
create policy tenant_configs_isolation on public.tenant_configs
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

drop policy if exists adapter_credentials_isolation on public.adapter_credentials;
create policy adapter_credentials_isolation on public.adapter_credentials
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

drop policy if exists platform_users_isolation on public.platform_users;
create policy platform_users_isolation on public.platform_users
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

drop policy if exists audit_log_isolation on public.audit_log;
create policy audit_log_isolation on public.audit_log
  using (
    coalesce(current_setting('app.is_super_admin', true), '') = 'true'
    or tenant_id::text = coalesce(current_setting('app.current_tenant_id', true), '')
  );

-- ── updated_at trigger ───────────────────────────────────────────────────────
create or replace function public.touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tenants_touch_updated on public.tenants;
create trigger tenants_touch_updated before update on public.tenants
  for each row execute function public.touch_updated_at();

drop trigger if exists tenant_configs_touch_updated on public.tenant_configs;
create trigger tenant_configs_touch_updated before update on public.tenant_configs
  for each row execute function public.touch_updated_at();

drop trigger if exists adapter_credentials_touch_updated on public.adapter_credentials;
create trigger adapter_credentials_touch_updated before update on public.adapter_credentials
  for each row execute function public.touch_updated_at();

-- ── billing_* (Paddle mirror) ────────────────────────────────────────────────
-- Canonical DDL lives in migrations/008_billing_paddle.sql. Mirrored from
-- verified Paddle webhooks; Paddle remains the source of truth. See
-- src/lib/billingRepo.ts for the access-gating rules that read `status`.
--
-- `billing_customers.email` is nullable on purpose — an out-of-order
-- subscription.created has to be able to stub the parent row before
-- customer.created supplies the email. See the migration for the full note.
create table if not exists public.billing_customers (
  customer_id  text primary key,
  tenant_id    uuid references public.tenants(id) on delete set null,
  email        text,
  status       text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists billing_customers_email_idx  on public.billing_customers (lower(email));
create index if not exists billing_customers_tenant_idx on public.billing_customers (tenant_id);

create table if not exists public.billing_subscriptions (
  subscription_id         text primary key,
  customer_id             text not null references public.billing_customers(customer_id) on delete cascade,
  tenant_id               uuid references public.tenants(id) on delete set null,
  status                  text not null,
  price_id                text not null default '',
  product_id              text not null default '',
  items                   jsonb not null default '[]'::jsonb,
  collection_mode         text,
  currency_code           text,
  scheduled_change_action text,
  scheduled_change_at     timestamptz,
  current_period_ends_at  timestamptz,
  canceled_at             timestamptz,
  last_event_at           timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists billing_subscriptions_customer_idx on public.billing_subscriptions (customer_id);
create index if not exists billing_subscriptions_tenant_idx   on public.billing_subscriptions (tenant_id);
create index if not exists billing_subscriptions_status_idx   on public.billing_subscriptions (status);

create table if not exists public.billing_transactions (
  transaction_id  text primary key,
  customer_id     text references public.billing_customers(customer_id) on delete set null,
  subscription_id text,
  tenant_id       uuid references public.tenants(id) on delete set null,
  status          text not null,
  currency_code   text,
  total           text,
  tax             text,
  billed_at       timestamptz,
  invoice_number  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists billing_transactions_customer_idx     on public.billing_transactions (customer_id);
create index if not exists billing_transactions_subscription_idx on public.billing_transactions (subscription_id);
create index if not exists billing_transactions_tenant_idx       on public.billing_transactions (tenant_id);

create table if not exists public.billing_webhook_events (
  event_id     text primary key,
  event_type   text not null,
  occurred_at  timestamptz,
  processed_at timestamptz not null default now()
);

create index if not exists billing_webhook_events_type_idx on public.billing_webhook_events (event_type, processed_at desc);

alter table public.billing_customers      enable row level security;
alter table public.billing_subscriptions  enable row level security;
alter table public.billing_transactions   enable row level security;
alter table public.billing_webhook_events enable row level security;
