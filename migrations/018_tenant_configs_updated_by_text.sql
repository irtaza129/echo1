-- ─────────────────────────────────────────────────────────────────────────────
-- tenant_configs.updated_by: uuid → text.
--
-- REQUIRED BEFORE THE READS CUTOVER. Without it every config save and every
-- signup returns 500.
--
-- migrations/001_tenants.sql declared:
--     updated_by uuid references users(id)
--
-- but every caller has always passed an email address:
--     register     → email.toLowerCase()
--     save-config  → req.jwtPayload.sub   (which IS the email for tenant users)
--
-- so every insert failed with `invalid input syntax for type uuid`, and
-- dualWrite() swallowed it. public.tenant_configs has therefore never held a
-- single row, for the entire life of the table. Exactly the audit_log bug
-- again: a write nobody checked, failing into a catch nobody read.
--
-- EXPECTED_COLUMNS in supabaseAdmin.ts did not catch it because the column
-- exists — it is the TYPE that was wrong. checkSchema() now compares declared
-- types as well, so this specific shape of drift is caught at boot.
--
-- text is the correct type, not a workaround:
--   * db/schema.sql already declares `updated_by text` — 001 is the divergent
--     one, and the live database followed 001.
--   * It mirrors audit_log.actor, whose comment states the reasoning: an actor
--     may be an email, "legacy-agent1101" or "super", so a FK to a user row
--     "would break for super_admin / system actors". The same is true here.
--   * The referenced table is `users` (from 001), which the application does
--     not use at all — it writes `platform_users`. The FK pointed at a table
--     that was never populated.
--
-- Idempotent. Safe to re-run. No data can be lost: the column is empty.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.tenant_configs
  drop constraint if exists tenant_configs_updated_by_fkey;

alter table public.tenant_configs
  alter column updated_by type text using updated_by::text;
