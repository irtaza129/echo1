-- ============================================================
-- Phase 0.2: Reconcile adapter_credentials with the application's writes
-- Run this in: Supabase SQL Editor → New Query → Run
-- ============================================================
--
-- Same drift as 002, found by the boot-time checkSchema() assertion.
--
-- 001_tenants.sql created adapter_credentials with (credentials_enc text not
-- null, iv). The application (src/lib/repo.ts → credentialsRepo.upsert) writes
-- (ciphertext, iv, algorithm), matching db/schema.sql instead. Every credential
-- dual-write has therefore been failing with PGRST204 and being swallowed by
-- dualWrite() at server.ts — adapter_credentials is empty (0 rows) as a result.
--
-- Redis is the primary store for credentials, so nothing user-facing broke;
-- the Postgres copy simply never existed.
--
-- NOTE the NOT NULL trap: adding `ciphertext` alone is not enough. While
-- `credentials_enc` stays NOT NULL, every insert that writes only `ciphertext`
-- fails on the null constraint instead — trading one silent failure for
-- another. The constraint must be dropped in the same migration.

alter table public.adapter_credentials add column if not exists ciphertext text;
alter table public.adapter_credentials add column if not exists algorithm  text not null default 'aes-256-gcm';

-- Preserve anything the old column captured. No-op on an empty table.
update public.adapter_credentials
   set ciphertext = coalesce(ciphertext, credentials_enc)
 where ciphertext is null and credentials_enc is not null;

-- Required: the app no longer writes credentials_enc, so its NOT NULL
-- constraint would reject every future upsert.
alter table public.adapter_credentials alter column credentials_enc drop not null;

-- The legacy column is now unused. Dropping it is irreversible — the table is
-- currently empty, so this is safe today, but uncomment deliberately.
-- alter table public.adapter_credentials drop column if exists credentials_enc;

-- PostgREST caches the schema; force a reload so the new columns are visible
-- immediately instead of waiting for the next automatic refresh.
notify pgrst, 'reload schema';
