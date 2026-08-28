-- ─────────────────────────────────────────────────────────────────────────────
-- Revoke the `anon` role from every table in `public`.
--
-- WHY NOW. The FastAPI service's .env was committed to a public GitHub repo in
-- three commits and removed in b71b86c. The blob survives in history. The value
-- is that project's SUPABASE anon key — NOT the service-role key, which was
-- never committed — and it does not expire until 2036.
--
-- That key was tested against all 26 tables in this database, read-only. It
-- reads zero rows today. Ten tables answer 42501 (permission denied) because
-- the other repo's 005_lock_down_business_tables.sql revoked them. The other
-- SIXTEEN answer `200 []`: the SELECT grant is still there and row-level
-- security is the only thing standing between a public credential and this
-- data. Among those sixteen are `adapter_credentials`, which holds tenants'
-- integration credentials, and `platform_users`, which holds login hashes.
--
-- One correct policy away from exposure, with no grant-level backstop. RLS
-- should be the second line, not the only one. This adds the first.
--
-- WHY A BLANKET REVOKE rather than a list. Nothing in this system authenticates
-- as `anon`: the browser bundles contain no Supabase client, every query goes
-- through src/lib/supabaseAdmin.ts with the service-role key, and the FastAPI
-- service raises ConfigurationError rather than falling back to anon. A list
-- would need maintaining and would silently miss the next table added. The
-- default-privileges clause below is what stops that recurring.
--
-- `authenticated` is deliberately left alone. It is equally unused, but reaching
-- it requires a Supabase Auth JWT and this platform issues its own tokens with
-- its own secret, so no attacker can mint one. `anon` is the role whose key is
-- public. Revisit if Supabase Auth is ever adopted.
--
-- SAFE FOR THE SERVICE-ROLE KEY. `service_role` holds its own grants and
-- BYPASSRLS; revoking `anon` does not touch it. Schema USAGE is left in place so
-- PostgREST answers cleanly rather than erroring at the connection.
--
-- MIGRATION NUMBERING: this database is shared with github.com/FassihHaroon/
-- voiceAI, which numbers its migrations from 001 independently. Their 005 and
-- this repo's 005_pos_core.sql are different files. There is no shared ledger of
-- what has been applied. Check both trees before assuming a number is free.
--
-- Idempotent. Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  n int := 0;
  r record;
begin
  for r in
    select schemaname, tablename
    from pg_tables
    where schemaname = 'public'
  loop
    execute format('revoke all on table %I.%I from anon', r.schemaname, r.tablename);
    n := n + 1;
  end loop;

  -- Views are separate relations and were part of the exposure: v_menu and
  -- v_order_summary were two of the ten the other repo's migration caught.
  for r in
    select schemaname, viewname
    from pg_views
    where schemaname = 'public'
  loop
    execute format('revoke all on table %I.%I from anon', r.schemaname, r.viewname);
    n := n + 1;
  end loop;

  raise notice '[020] revoked anon on % relations in public', n;
end $$;

-- Sequences: `usage` on a sequence lets a role advance it. Nothing anon can
-- insert makes that reachable, but it costs nothing to close and migration 019
-- has just made these load-bearing for menu inserts.
do $$
declare
  r record;
begin
  for r in
    select sequence_schema, sequence_name
    from information_schema.sequences
    where sequence_schema = 'public'
  loop
    execute format('revoke all on sequence %I.%I from anon', r.sequence_schema, r.sequence_name);
  end loop;
end $$;

-- The part that stops this recurring. Without it, the next `create table` in
-- public re-grants anon by default and the hole reopens silently — which is how
-- sixteen tables ended up in this state in the first place.
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;

-- PostgREST caches the schema. Without this the change is live in Postgres but
-- the API keeps serving its old view of it — the same staleness that made a
-- migration look unapplied earlier in this project's history.
notify pgrst, 'reload schema';
