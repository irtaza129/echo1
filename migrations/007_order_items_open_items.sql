-- ============================================================
-- Phase POS-2: Allow order lines that are not menu dishes
-- Run this in: Supabase SQL Editor → New Query → Run
-- Depends on: 004_pos_orders_extend.sql
-- ============================================================
--
-- `order_items.dish_id` is currently NOT NULL. That is a correct constraint for
-- the FastAPI kiosk flow, where every line is resolved against the menu before
-- it can be added.
--
-- It is wrong for a POS. Tills have to sell things that are not on the menu:
--   • an "open item" / miscellaneous charge rung in by hand
--   • a corkage or service line
--   • a line recovered from the browser's cart after the server-side cart
--     expired, where the dish id is no longer known but the sale is real
--
-- Without this, a cashier hits "misc item" and the sale fails with a NOT NULL
-- violation at the moment of payment. Relaxing the column is additive and
-- invisible to FastAPI, which always supplies a dish_id.
--
-- The line remains fully described regardless: `dish_name`, `unit_price` and
-- `selected_options` are all snapshots taken at ring-in, so a null dish_id
-- costs nothing on the receipt or in reporting.

alter table public.order_items alter column dish_id drop not null;

-- Same reasoning for the modifier snapshot: an open item has no options, and
-- being forced to write an empty array is a trap for any client that forgets.
alter table public.order_items alter column selected_options drop not null;

notify pgrst, 'reload schema';
