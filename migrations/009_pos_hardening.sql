-- ============================================================
-- Phase POS-3: One ledger — columns the unified order path needs
-- Run this in: Supabase SQL Editor → New Query → Run
-- Depends on: 004_pos_orders_extend.sql, 005_pos_core.sql, 007_order_items_open_items.sql
-- ============================================================
--
-- Context: until now, voice/kiosk/WhatsApp orders were written to Redis
-- (`local:order:*`, 30-day TTL, last 500 per tenant) while POS orders were
-- written here. Two ledgers meant no Z-report could balance, no refund could
-- find its original sale, and 30 days of history simply evaporated.
--
-- Every channel now writes to `public.orders` through PosAdapter. This migration
-- adds the columns that unification needs and that a real POS audit requires.
-- Everything is additive and nullable — FastAPI keeps working untouched.

-- ── orders.instructions ──────────────────────────────────────────────────────
-- posRepo.ordersRepo.create() has always written this column and OrderRow has
-- always declared it, but no migration ever created it. On a database where
-- FastAPI did not happen to define it, every POS insert would fail with
-- PGRST204 — the same silent-failure class that killed the audit trail in
-- migration 002. Guarded so it is a no-op where the column already exists.
alter table public.orders add column if not exists instructions text;

-- ── orders.payment_ref ───────────────────────────────────────────────────────
-- The gateway's own reference for the payment that settled this order (a Paddle
-- transaction id, a Safepay tracker token). The Redis order shape had this
-- field; the Postgres one never did, because migration 002 tried to CREATE an
-- `orders` table that already existed with a different shape — a no-op that
-- added nothing. Without this column a card payment can be captured with no
-- way to tie the money back to the sale.
--
-- Note `payment_status`/`payment_method` DO exist: they are FastAPI's, kept for
-- its single-tender flow. Split tenders live in pos_payments (migration 005);
-- these two columns describe the order's headline payment only.
alter table public.orders add column if not exists payment_ref text;

create index if not exists orders_payment_ref_idx
  on public.orders (payment_ref) where payment_ref is not null;

-- ── orders.source as a closed set ────────────────────────────────────────────
-- `source` drives every channel-attribution report: it is the number that says
-- whether the AI channels earn their keep. A typo'd 'kiosc' would quietly split
-- a column in two and nobody would notice until the figures were already wrong.
--
-- Existing rows are normalised first — the constraint cannot be added while any
-- row violates it, and 004 defaulted every pre-existing row to 'kiosk'.
update public.orders
   set source = 'kiosk'
 where source is null
    or source not in ('pos', 'kiosk', 'phone', 'whatsapp', 'qr', 'web');

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_source_check') then
    alter table public.orders
      add constraint orders_source_check
      check (source in ('pos', 'kiosk', 'phone', 'whatsapp', 'qr', 'web'));
  end if;
end $$;

-- Reporting reads "all orders for tenant X in date range Y grouped by source".
-- 004 already indexes (tenant_id, created_at desc); this covers the grouping.
create index if not exists orders_tenant_source_idx
  on public.orders (tenant_id, source, created_at desc);

-- ── Discounts and voids: who, and why ────────────────────────────────────────
-- A discount amount with no reason and no approver is not auditable, and
-- "the manager said it was fine" is not a record. 004 gave us `void_reason`
-- but not who authorised it; a POS needs both halves for every write-down.
--
-- The *_by columns are uuids referencing platform_users, but deliberately carry
-- no FK: a staff member who leaves gets their row deleted, and that must not
-- cascade into rewriting last year's receipts.
alter table public.orders add column if not exists discount_reason text;
alter table public.orders add column if not exists discount_by     uuid;
alter table public.orders add column if not exists void_by         uuid;

alter table public.order_items add column if not exists line_discount_reason text;
alter table public.order_items add column if not exists void_by              uuid;

-- ── orders.channel_ref ───────────────────────────────────────────────────────
-- Correlates an order back to the conversation that produced it: a call id for
-- the phone agent, a dine-session id for QR, a WhatsApp message id. Without it,
-- "why did this order say 3 biryanis" has no transcript to answer from.
alter table public.orders add column if not exists channel_ref text;

create index if not exists orders_channel_ref_idx
  on public.orders (tenant_id, channel_ref) where channel_ref is not null;

-- ── orders.branch_id ─────────────────────────────────────────────────────────
-- Forward compatibility for multi-branch tenants. No `branches` table yet and
-- no FK, so this is inert today — but adding a nullable column now means the
-- multi-branch migration later is a backfill rather than a rewrite of every
-- query that already filters on tenant_id.
alter table public.orders        add column if not exists branch_id uuid;
alter table public.venue_tables  add column if not exists branch_id uuid;

notify pgrst, 'reload schema';

-- ── Widen the CHECK constraints the POS would otherwise violate ──────────────
-- Discovered by inspecting the live database, not by reading a migration: these
-- four constraints predate every POS migration and were written for the
-- FastAPI delivery flow only. Each one silently rejects a write the POS code
-- already makes today:
--
--   status         : ordersRepo.void() writes 'voided'         → not allowed
--   payment_status : applyPayment() writes the gateway's own
--                    'initiated'/'captured'/'failed'           → not allowed
--   payment_method : applyPayment() writes 'paddle'/'safepay'  → not allowed
--   order_type     : the phone and POS flows sell 'takeaway'   → not allowed
--
-- Widening a CHECK is strictly permissive: every value FastAPI writes today
-- stays valid, so this cannot break the existing backend. Dropping and
-- recreating is the only way to alter a CHECK in Postgres.
--
-- These stay as CHECKs rather than becoming enums so FastAPI can keep inserting
-- without needing to know a new type exists.

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders
  add constraint orders_status_check
  check (status in ('pending','confirmed','preparing','ready',
                    'out_for_delivery','delivered','cancelled','voided'));

alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders
  add constraint orders_payment_status_check
  check (payment_status in ('unpaid','paid','refunded','initiated','authorized',
                            'captured','failed','cancelled','partially_refunded'));

alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders
  add constraint orders_payment_method_check
  check (payment_method in ('cash','card','online','paddle','safepay',
                            'wallet','bank','voucher','other'));

-- 'takeaway' and 'pickup' are distinct on purpose: pickup is ordered ahead and
-- collected later, takeaway is ordered at the counter and waited for. The
-- kitchen prioritises them differently.
alter table public.orders drop constraint if exists orders_order_type_check;
alter table public.orders
  add constraint orders_order_type_check
  check (order_type in ('delivery','pickup','dine_in','takeaway'));

notify pgrst, 'reload schema';
