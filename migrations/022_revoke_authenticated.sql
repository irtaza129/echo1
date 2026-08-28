-- ─────────────────────────────────────────────────────────────────────────────
-- Revoke `authenticated` from `public`, completing 020 and 021.
--
-- 020 and 021 deliberately left this role alone, on the argument that reaching
-- it requires a JWT signed with the project's JWT secret, and that secret did
-- not leak — the exposed .env held SUPABASE_URL and the anon key only.
--
-- That argument had an unstated premise: that nobody can obtain such a token.
-- `select count(*) from auth.users` now answers it. The query RAN, so GoTrue is
-- provisioned and auth.users exists; it returned zero, so nobody has registered.
-- Provisioned-and-empty is not the same as absent: if signups are enabled,
-- anyone can register and be handed a role that both default-privilege sets
-- grant arwdDxtm on every future table in public.
--
-- Behind it stand 14 tables with RLS enabled and NO policies. Those deny by
-- default, so this is not a live breach — it is the same single-layer posture
-- that made the anon grant worth closing, on a role whose population can go from
-- zero to one through a public sign-up form.
--
-- NOTHING USES IT. Neither service authenticates as `authenticated`: this app
-- signs its own tokens with its own secret and queries as service_role, and the
-- FastAPI service raises rather than falling back. No browser bundle in either
-- repo contains a Supabase client.
--
-- REVERSIBLE. If Supabase Auth is ever adopted, grant it back deliberately, per
-- table, alongside the RLS policies that should accompany it — which is the
-- order it should have been done in to begin with.
--
-- `service_role` is untouched and keeps BYPASSRLS. Schema USAGE stays.
--
-- Idempotent. Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  n int := 0;
  r record;
begin
  for r in select schemaname, tablename as rel from pg_tables where schemaname = 'public'
     union all
           select schemaname, viewname  as rel from pg_views  where schemaname = 'public'
  loop
    execute format('revoke all on table %I.%I from authenticated', r.schemaname, r.rel);
    n := n + 1;
  end loop;
  raise notice '[022] revoked authenticated on % relations in public', n;
end $$;

do $$
declare
  r record;
begin
  for r in
    select sequence_schema, sequence_name
    from information_schema.sequences
    where sequence_schema = 'public'
  loop
    execute format('revoke all on sequence %I.%I from authenticated',
                   r.sequence_schema, r.sequence_name);
  end loop;
end $$;

alter default privileges in schema public revoke all on tables    from authenticated;
alter default privileges in schema public revoke all on sequences from authenticated;
alter default privileges in schema public revoke all on functions from authenticated;

-- The half 020 could not reach — see 021 for why ALTER DEFAULT PRIVILEGES binds
-- only the role that runs it.
do $$
begin
  execute 'alter default privileges for role supabase_admin in schema public revoke all on tables    from authenticated';
  execute 'alter default privileges for role supabase_admin in schema public revoke all on sequences from authenticated';
  execute 'alter default privileges for role supabase_admin in schema public revoke all on functions from authenticated';
exception
  when insufficient_privilege then
    raise warning '[022] SKIPPED supabase_admin defaults — this role cannot alter them. '
                  'Tables later created BY supabase_admin will still grant authenticated.';
end $$;

notify pgrst, 'reload schema';
