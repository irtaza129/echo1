-- ─────────────────────────────────────────────────────────────────────────────
-- payment_transactions: allow 'paddle', and make the table reachable from code.
--
-- Migration 002 provisioned public.payment_transactions as the durable target
-- for diner card payments, but nothing ever wrote to it — savePaymentTxn() in
-- server.ts persisted only to Redis under `payment:<ref>` with a 30-day TTL, so
-- every card payment record silently disappeared a month after it was taken.
-- This migration is the schema half of wiring that write up for real.
--
-- Two problems with 002's shape had to be fixed before the table could accept a
-- live row:
--
--   1. The provider check listed ('cash','safepay','paymob','bank_ipg',
--      'pos_passthrough') — written before Paddle existed here. Paddle is now
--      the provider that actually takes diner card money, so every insert would
--      have failed the constraint.
--
--   2. order_id was `references public.orders(id) on delete set null`. Orders
--      are the ledger; a payment row that outlives its order is the whole point
--      of a durable payment record (reconciliation against settlement files
--      happens long after an order may have been purged), so set null is right
--      and is kept. Only the check constraint changes.
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.payment_transactions
  drop constraint if exists payment_transactions_provider_check;

alter table public.payment_transactions
  add constraint payment_transactions_provider_check
  check (provider in ('cash','safepay','paddle','paymob','bank_ipg','pos_passthrough'));

-- The (provider, provider_ref) unique index from 002 is what makes the write
-- path idempotent — savePaymentTxn upserts on it, so a webhook redelivery
-- updates the existing row instead of creating a duplicate attempt. Recreated
-- here defensively in case 002 was applied against a table that predated it.
create unique index if not exists payment_tx_provider_ref_idx
  on public.payment_transactions (provider, provider_ref);
