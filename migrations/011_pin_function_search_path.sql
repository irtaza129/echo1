-- ============================================================
-- Phase POS-5: pin search_path on the functions POS/RES created
-- Run this in: Supabase SQL Editor -> New Query -> Run
-- Depends on: 004_pos_orders_extend.sql, 006_reservations.sql
-- ============================================================
--
-- Flagged by the Supabase database linter (0011_function_search_path_mutable).
--
-- A function with a mutable search_path resolves unqualified names against
-- whatever the CALLER's search_path happens to be, so a caller who puts their
-- own schema in front can shadow a table or operator the function meant to use.
--
-- Both functions already fully-qualify every object they touch, so an empty
-- search_path changes nothing about their behaviour -- it just removes the
-- shadowing class entirely.
--
-- Only these two are altered. touch_updated_at() and update_updated_at() carry
-- the same lint, but they predate this work and are shared with the FastAPI
-- backend, so they are left alone deliberately rather than changed in passing.

alter function public.pos_next_order_number(uuid) set search_path = '';
alter function public.res_sync_reservation_tables() set search_path = '';
