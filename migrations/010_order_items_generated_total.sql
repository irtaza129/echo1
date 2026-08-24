-- ============================================================
-- Phase POS-4: make order_items.item_total discount-aware
-- Run this in: Supabase SQL Editor -> New Query -> Run
-- Depends on: 004_pos_orders_extend.sql (adds line_discount)
-- ============================================================
--
-- item_total is a GENERATED ALWAYS column -- Postgres computes it and rejects
-- any insert that supplies a value. posRepo.ordersRepo.create() and
-- scripts/backfill-pos.ts both wrote it explicitly, so EVERY order insert would
-- have failed with:
--
--   cannot insert a non-DEFAULT value into column "item_total"
--
-- This was invisible until the POS actually ran against the live schema: no
-- migration declares this table, because it belongs to the FastAPI backend.
-- Both call sites are fixed alongside this migration.
--
-- The original expression was (quantity * unit_price) and ignored line_discount,
-- which did not exist when it was written -- 004 added it. computeTotals()
-- subtracts the line discount when it builds the order subtotal, so a discounted
-- line made item_total disagree with the order total it sums into: the receipt
-- lines would not add up to the receipt total.
--
-- Safe for FastAPI: line_discount is NOT NULL DEFAULT 0, so for every existing
-- row, and every row FastAPI writes, the new expression yields exactly the same
-- number as the old one. Postgres 17 can alter a generated expression in place;
-- the table is rewritten, which is trivial at this size.

alter table public.order_items
  alter column item_total
  set expression as ((quantity)::numeric * unit_price - line_discount);

notify pgrst, 'reload schema';
