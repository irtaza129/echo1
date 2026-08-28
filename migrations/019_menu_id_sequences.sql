-- ─────────────────────────────────────────────────────────────────────────────
-- Give the menu tables the id defaults both services already assume they have.
--
-- SHARED SCHEMA — this table set is written by the FastAPI service too. Applying
-- it fixes a broken endpoint on both sides at once. Coordinate before applying,
-- but note it cannot break anything that currently works (see below).
--
-- What is actually true today, verified against the live database via
-- PostgREST's OpenAPI document:
--
--     categories.id        int4, NOT NULL, no default
--     sub_categories.id    int4, NOT NULL, no default
--     dishes.id            int4, NOT NULL, no default
--     dish_options.id      int4, NOT NULL, no default
--     dish_sub_options.id  int4, NOT NULL, no default
--     orders.id            uuid, NOT NULL, default gen_random_uuid()   ← for contrast
--
-- The menu ids are large scraped values (max dishes.id = 2468438) assigned by
-- whatever system the menu was imported from. No sequence has ever existed.
--
-- The consequence, on both sides:
--
--   * src/lib/posMenuWrite.ts inserts without an id and states in its header that
--     these tables "each own an identity sequence (categories_id_seq and
--     friends), verified against the live database". That is false. Every INSERT
--     it has ever attempted failed on a not-null violation, so ADDING a menu item
--     through the admin panel has never worked for a native POS tenant. Renaming,
--     repricing and retiring go through UPDATE and were unaffected, which is why
--     this looked like a working feature.
--
--   * The FastAPI service's POST /api/v1/admin/menu likewise never assigns an id.
--     Its on_conflict upsert does not rescue it: Postgres checks NOT NULL on the
--     candidate tuple before ON CONFLICT arbitration, so even a row that already
--     exists fails.
--
-- This migration is additive and cannot regress either service: nothing can
-- currently insert successfully without supplying an id, and rows that supply one
-- explicitly keep working unchanged.
--
-- AFTER THIS: any process that still inserts an explicit id MUST advance the
-- sequence itself (setval), or it walks the sequence toward a collision with a
-- row that already exists. scripts/backfill-pos.ts was the only such caller and
-- has been changed to omit the id. A future menu scrape that carries external ids
-- needs the same treatment.
--
-- Idempotent. Safe to re-run: setval is recomputed from max(id) each time.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  t text;
  seq text;
  next_id bigint;
begin
  foreach t in array array[
    'categories', 'sub_categories', 'dishes', 'dish_options', 'dish_sub_options'
  ] loop
    seq := format('%I', t || '_id_seq');

    -- `owned by` ties the sequence's lifetime to the column, so dropping the
    -- table does not strand it.
    execute format('create sequence if not exists public.%s owned by public.%I.id', seq, t);

    -- Start immediately above whatever the import left behind. is_called = false
    -- means the next nextval() returns exactly this value rather than one past it.
    execute format('select coalesce(max(id), 0) + 1 from public.%I', t) into next_id;
    execute format('select setval(''public.%s'', %s, false)', seq, next_id);

    execute format('alter table public.%I alter column id set default nextval(''public.%s'')', t, seq);
  end loop;
end $$;
