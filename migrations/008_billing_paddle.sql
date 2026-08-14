-- ─────────────────────────────────────────────────────────────────────────────
-- Billing — Paddle subscription mirror (Supabase / Postgres)
--
-- Paddle is the source of truth for billing. These tables are a MIRROR kept up
-- to date by verified webhook deliveries (routes/billing.ts →
-- src/lib/paddleWebhook.ts). The app reads its own mirror to gate access;
-- the Paddle API is reserved for mutations (cancel, update, portal sessions).
--
-- Naming: prefixed `billing_` for the same reason POS tables are prefixed
-- `pos_` and reservations `res_`. A bare `customers` table would be ambiguous
-- in a restaurant platform that already plans `pos_customers` for diners —
-- these rows are the SaaS tenants who pay us, not the people who eat.
--
-- Idempotent: every object uses `if not exists`. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;

-- ── billing_customers ────────────────────────────────────────────────────────
-- One row per Paddle customer (ctm_...). `tenant_id` is the bridge to our own
-- world and is populated from checkout custom_data when present; it stays null
-- for customers we cannot attribute yet, which is why it is nullable.
--
-- `email` is NULLABLE on purpose, and this is a deliberate deviation from the
-- obvious `email text not null`. Webhook delivery is unordered: a
-- subscription.created can land before its customer.created. The subscription
-- handler therefore has to be able to create a stub parent row keyed only on
-- customer_id, with the email filled in moments later by customer.created.
-- A not-null constraint here would turn ordinary out-of-order delivery into a
-- hard failure loop.
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

-- ── billing_subscriptions ────────────────────────────────────────────────────
-- One row per Paddle subscription (sub_...). `status` is the ONLY field access
-- gating reads — see subscriptionGrantsAccess() in src/lib/billingRepo.ts.
--
-- scheduled_change_action / scheduled_change_at record a pending cancel or
-- pause. They are display state, NOT access state: a subscription with a
-- pending cancel is still `active` and still entitled until Paddle actually
-- flips the status on the effective date.
--
-- `items` keeps the full line-item array. price_id / product_id denormalise the
-- first item for cheap querying; hybrid plans (base + addons) need the array.
--
-- `last_event_at` is the occurred_at of the newest event applied to this row.
-- It lets the handler drop a late-arriving retry of an OLDER event instead of
-- clobbering newer state with stale values.
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

-- ── billing_transactions ─────────────────────────────────────────────────────
-- Completed transactions (txn_...). Append-mostly; the receipt trail behind a
-- subscription. Totals are strings in the LOWEST denomination exactly as Paddle
-- sends them ("1000" = 10.00) — never parsed into a float, for the same reason
-- payment_transactions stores integer paisa.
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

-- ── billing_webhook_events ───────────────────────────────────────────────────
-- Idempotency ledger. Paddle delivers AT LEAST ONCE and re-sends the identical
-- event_id on every retry, so this table is what stops a redelivery from
-- repeating a non-idempotent side effect (receipts, one-off credits).
--
-- The state mirrors above are upsert-shaped and idempotent on their own; this
-- ledger exists for the side effects that are not, and doubles as a delivery
-- audit trail when reconciling against Paddle's notification log.
create table if not exists public.billing_webhook_events (
  event_id     text primary key,
  event_type   text not null,
  occurred_at  timestamptz,
  processed_at timestamptz not null default now()
);

create index if not exists billing_webhook_events_type_idx on public.billing_webhook_events (event_type, processed_at desc);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Consistent with every other table here: policies are scaffolding for the day
-- the app moves off the service-role key. The server writes these rows with the
-- service-role key today and bypasses RLS entirely. Billing data must NEVER be
-- readable by an anon client.
alter table public.billing_customers     enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.billing_transactions  enable row level security;
alter table public.billing_webhook_events enable row level security;
