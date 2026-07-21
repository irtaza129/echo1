-- ============================================================
-- Phase 0: Multi-tenant foundation
-- Run this in: Supabase SQL Editor → New Query → Run
-- ============================================================

-- Enable pgcrypto for gen_random_uuid()
create extension if not exists pgcrypto;

-- ── Tenants ──────────────────────────────────────────────────
create table if not exists tenants (
  id                uuid primary key default gen_random_uuid(),
  slug              varchar(64) not null unique,       -- savour-foods
  name              varchar(255) not null,
  plan              varchar(32) not null default 'starter', -- starter | growth | enterprise
  status            varchar(32) not null default 'active',  -- active | suspended | trial
  stripe_customer_id varchar(255),
  created_at        timestamptz not null default now()
);

-- ── Users ────────────────────────────────────────────────────
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants(id) on delete cascade,  -- null = super_admin
  email         varchar(255) not null unique,
  password_hash varchar(255) not null,
  role          varchar(32) not null,  -- super_admin | tenant_admin | manager | staff | kiosk
  created_at    timestamptz not null default now()
);

-- ── Tenant configs ───────────────────────────────────────────
-- Stores everything in TenantConfig EXCEPT adapter credentials
create table if not exists tenant_configs (
  tenant_id  uuid primary key references tenants(id) on delete cascade,
  config     jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id)
);

-- ── Adapter credentials (encrypted at rest) ──────────────────
-- AES-256-GCM; credentials_enc + iv stored as hex text
-- SUPERSEDED by migrations/003_adapter_credentials_ciphertext.sql.
-- The application writes `ciphertext` and `algorithm`, not `credentials_enc`.
-- 003 must be run after this file on a fresh database. As with audit_log above,
-- do not edit this block — 001 is already applied in production.
create table if not exists adapter_credentials (
  tenant_id        uuid primary key references tenants(id) on delete cascade,
  credentials_enc  text not null,   -- hex-encoded ciphertext
  iv               text not null,   -- hex-encoded 12-byte IV
  updated_at       timestamptz not null default now()
);

-- ── Kiosk sessions ───────────────────────────────────────────
create table if not exists kiosk_sessions (
  session_id  uuid primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  created_at  timestamptz not null default now(),
  last_active timestamptz not null default now()
);

-- ── Audit log ────────────────────────────────────────────────
-- SUPERSEDED by migrations/002_audit_log_actor_details.sql.
-- The application writes `actor` (opaque text: emails, "super",
-- "legacy-agent1101") and `details` (text) — not actor_id/payload. Applying 001
-- to a fresh database still creates these columns, so 002 must be run after it.
-- Do not "fix" this by editing the block below: 001 has already been applied to
-- production and editing an applied migration makes environments diverge.
create table if not exists audit_log (
  id         bigserial primary key,
  tenant_id  uuid references tenants(id),
  actor_id   uuid references users(id),
  action     varchar(128) not null,
  payload    jsonb,
  created_at timestamptz not null default now()
);

-- ── Indexes ──────────────────────────────────────────────────
create index if not exists idx_users_tenant        on users(tenant_id);
create index if not exists idx_kiosk_sessions_tenant on kiosk_sessions(tenant_id);
create index if not exists idx_audit_log_tenant    on audit_log(tenant_id);
create index if not exists idx_audit_log_created   on audit_log(created_at desc);

-- ── Row-level security ───────────────────────────────────────
alter table tenants            enable row level security;
alter table users              enable row level security;
alter table tenant_configs     enable row level security;
alter table adapter_credentials enable row level security;
alter table kiosk_sessions     enable row level security;
alter table audit_log          enable row level security;

-- Service role bypasses RLS (used by our server — never by browser)
-- Anon/authenticated roles cannot see any rows without a matching policy.
-- We use the service role key exclusively from server.ts, so no
-- additional policies are needed for the MVP — the server enforces
-- tenant isolation in application code before hitting the DB.

-- ── Seed: Savour Foods tenant (existing client) ───────────────
-- This preserves backward compatibility with the current single-tenant setup.
insert into tenants (id, slug, name, plan, status)
values (
  '00000000-0000-4000-8000-000000000001',
  'savour-foods',
  'Savour Foods',
  'growth',
  'active'
) on conflict (slug) do nothing;

-- Savour Foods config — mirrors current hardcoded values in server.ts / geminiTools.ts
insert into tenant_configs (tenant_id, config) values (
  '00000000-0000-4000-8000-000000000001',
  '{
    "tenantId": "00000000-0000-4000-8000-000000000001",
    "slug": "savour-foods",
    "restaurantName": "Savour Foods",
    "plan": "growth",
    "adapter": {
      "type": "managed"
    },
    "gemini": {
      "agentName": "Savour Assistant",
      "voice": "Puck",
      "languages": ["en", "ur", "roman-ur"],
      "systemPromptExtras": "Cola means Cola Next. Sprite means Fizzup. Water means Savour Mineral Water. Always upsell the deal of the day if available."
    },
    "branding": {
      "primaryColor": "#C8102E",
      "logoUrl": "",
      "kioskTitle": "Welcome to Savour Foods"
    },
    "businessRules": {
      "gstRate": 0.15,
      "currencySymbol": "PKR",
      "orderStatusMachine": ["pending", "confirmed", "preparing", "ready", "out_for_delivery", "delivered"]
    },
    "features": {
      "deliveryOrders": false,
      "tableNumbers": true,
      "transcriptScreen": true,
      "loyaltyPoints": false
    }
  }'
) on conflict (tenant_id) do nothing;

-- Savour Foods super-admin user
-- Password hash is SHA-256 of the current AUTH_PASSWORD
-- Replace password_hash with: node -e "require('crypto').createHash('sha256').update('YOUR_PASSWORD').digest('hex')|console.log"
insert into users (id, tenant_id, email, password_hash, role)
values (
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000001',
  'admin@savourfoods.com',
  'a3046da0d15a27e89f2afe639b25748a7ad4d9290af3e7b1b6c1a5533c8f0a8c',  -- default dev password
  'tenant_admin'
) on conflict (email) do nothing;
