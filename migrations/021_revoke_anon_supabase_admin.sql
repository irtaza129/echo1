-- ─────────────────────────────────────────────────────────────────────────────
-- Close the half of migration 020 that 020 could not reach.
--
-- 020's `alter default privileges in schema public` applies ONLY to objects
-- created by the role that executed it — `postgres`, in the Supabase SQL editor.
-- Verified afterwards against pg_default_acl, which showed exactly that split:
--
--   postgres        r  {postgres=arwdDxtm/…, authenticated=…, service_role=…}
--   supabase_admin  r  {postgres=…, anon=arwdDxtm/…, authenticated=…, …}
--
-- So a table created by `supabase_admin` still grants `anon` arwdDxtm — every
-- privilege, not merely SELECT — and sequences (rwU) and functions (X) with it.
-- Extension installs and some dashboard operations create objects as that role,
-- so this is not hypothetical, and it reopens silently: nothing fails, the next
-- table is simply readable by a credential that ships in client applications.
--
-- MAY NOT BE PERMITTED. Altering another role's default privileges requires
-- membership of that role. On Supabase, `postgres` is not a superuser and may be
-- refused. That is why this reports rather than aborts — a migration that dies
-- here would leave 020's own work looking incomplete. If it reports SKIPPED,
-- raise it with Supabase support; it cannot be fixed from the SQL editor.
--
-- `authenticated` is still deliberately untouched, and the reasoning is
-- unchanged: reaching it needs a JWT signed with the project's JWT secret, which
-- did not leak — the exposed .env held SUPABASE_URL and the anon key only. But
-- see the note at the foot of this file: that reasoning depends on Supabase Auth
-- signups being disabled, which is worth confirming rather than assuming.
--
-- Idempotent. Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  execute 'alter default privileges for role supabase_admin in schema public revoke all on tables    from anon';
  execute 'alter default privileges for role supabase_admin in schema public revoke all on sequences from anon';
  execute 'alter default privileges for role supabase_admin in schema public revoke all on functions from anon';
  raise notice '[021] supabase_admin default privileges revoked from anon';
exception
  when insufficient_privilege then
    raise warning '[021] SKIPPED — this role cannot alter supabase_admin default privileges. '
                  'Future tables created BY supabase_admin will still grant anon. '
                  'Raise with Supabase support; re-run 020 after any such table appears.';
end $$;

-- Re-run 020's blanket revoke. 020 revoked what existed at the time; anything
-- created between then and now by supabase_admin inherited the anon grant this
-- file has just closed for the future.
do $$
declare
  n int := 0;
  r record;
begin
  for r in select schemaname, tablename as rel from pg_tables where schemaname = 'public'
     union all
           select schemaname, viewname  as rel from pg_views  where schemaname = 'public'
  loop
    execute format('revoke all on table %I.%I from anon', r.schemaname, r.rel);
    n := n + 1;
  end loop;
  raise notice '[021] re-revoked anon on % relations', n;
end $$;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- OPEN QUESTION, not fixed here.
--
-- Both role groups grant `authenticated` arwdDxtm on every future table in
-- public. That is safe only while nobody can obtain an `authenticated` token —
-- i.e. while Supabase Auth signups are disabled on this project. If they are
-- enabled, anyone who registers holds a role with full default privileges on
-- every table, and the 14 tables with RLS enabled but NO policies are the only
-- thing standing in the way.
--
-- Check: Dashboard → Authentication → Providers. If email signup is on, this
-- needs the same treatment as anon, and it is more urgent than anon ever was.
-- ─────────────────────────────────────────────────────────────────────────────
