-- ============================================================
-- Phase 0.1: Reconcile audit_log with the application's writes
-- Run this in: Supabase SQL Editor → New Query → Run
-- ============================================================
--
-- Why this exists
-- ---------------
-- 001_tenants.sql created audit_log with (actor_id uuid → users(id), payload
-- jsonb). The application (src/lib/repo.ts → auditRepo.append) writes (actor
-- text, details text), matching db/schema.sql instead. Every dual-write has
-- therefore been failing with:
--
--   PGRST204: Could not find the 'actor' column of 'audit_log' in the schema cache
--
-- The failure is swallowed by dualWrite() in src/lib/repo.ts, so it only ever
-- surfaced as a [DB] warning — the audit trail has been recording nothing.
--
-- `actor` is deliberately an opaque text string, not a uuid FK: actors include
-- "super", "legacy-agent1101" and bare emails that have no row in users(id).
-- That is why db/schema.sql dropped the FK, and why we converge on that shape
-- rather than changing the application to write actor_id.

alter table public.audit_log add column if not exists actor   text;
alter table public.audit_log add column if not exists details text;

-- Preserve anything the old columns captured. No-ops on an empty table.
update public.audit_log
   set actor = coalesce(actor, actor_id::text)
 where actor is null and actor_id is not null;

update public.audit_log
   set details = coalesce(details, payload::text)
 where details is null and payload is not null;

-- The legacy columns are nullable and now unused. Dropping them is optional and
-- irreversible — uncomment only once you've confirmed nothing else reads them.
-- alter table public.audit_log drop column if exists actor_id;
-- alter table public.audit_log drop column if exists payload;

-- PostgREST caches the schema; force a reload so the new columns are visible
-- immediately instead of waiting for the next automatic refresh.
notify pgrst, 'reload schema';
