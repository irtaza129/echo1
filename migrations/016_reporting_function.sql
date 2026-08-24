-- ============================================================
-- Phase REPORT-1: sales reporting
-- Run this in: Supabase SQL Editor -> New Query -> Run
-- Depends on: 004_pos_orders_extend.sql, 005_pos_core.sql
-- ============================================================
--
-- One function returning one JSON document, rather than the app fetching rows
-- and aggregating them in JavaScript. A month of trading is thousands of orders
-- and tens of thousands of lines; pulling that over PostgREST to count it would
-- be slow, memory-hungry, and would quietly get slower as the tenant succeeded
-- -- the wrong direction for a number to move.
--
-- Voided orders are excluded from every money figure but COUNTED separately.
-- A day with thirty voids is telling you something, and a report that silently
-- drops them is the one that hides it.
--
-- search_path is pinned empty and every object is schema-qualified, so the
-- function cannot be redirected by a caller who puts their own schema first.

create or replace function public.pos_report_summary(
  p_tenant uuid,
  p_from   timestamptz,
  p_to     timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
with scoped as (
  select *
    from public.orders o
   where o.tenant_id  = p_tenant
     and o.created_at >= p_from
     and o.created_at <  p_to
),
live as (
  select * from scoped where voided_at is null
),
-- Money, in one pass.
totals as (
  select
    count(*)                                        as order_count,
    coalesce(sum(subtotal),       0)                as subtotal,
    coalesce(sum(discount),       0)                as discount,
    coalesce(sum(service_charge), 0)                as service_charge,
    coalesce(sum(tax_total),      0)                as tax,
    coalesce(sum(total_amount),   0)                as total,
    -- Average order value is the number a manager actually acts on; computing
    -- it here avoids every caller dividing by zero on a quiet day.
    case when count(*) = 0 then 0
         else round(coalesce(sum(total_amount), 0) / count(*), 2) end as average_order
  from live
),
voided as (
  select count(*) as n, coalesce(sum(total_amount), 0) as value
    from scoped where voided_at is not null
),
-- Channel attribution: the number that says whether the AI channels earn their
-- keep. This is the whole reason orders.source is a closed set.
by_source as (
  select jsonb_agg(x order by x.total desc) as rows from (
    select source,
           count(*)                      as orders,
           coalesce(sum(total_amount),0) as total
      from live group by source
  ) x
),
by_type as (
  select jsonb_agg(x order by x.total desc) as rows from (
    select order_type,
           count(*)                      as orders,
           coalesce(sum(total_amount),0) as total
      from live group by order_type
  ) x
),
-- Tender mix comes from pos_payments, not orders.payment_method: a split
-- payment has several rows and only pos_payments knows about all of them.
by_tender as (
  select jsonb_agg(x order by x.net desc) as rows from (
    select p.method,
           count(*)                                       as count,
           coalesce(sum(p.amount), 0)                     as gross,
           coalesce(sum(p.refunded_amount), 0)            as refunded,
           coalesce(sum(p.amount - p.refunded_amount), 0) as net
      from public.pos_payments p
     where p.tenant_id  = p_tenant
       and p.created_at >= p_from
       and p.created_at <  p_to
       and p.status <> 'voided'
     group by p.method
  ) x
),
-- Local hour, not UTC. A restaurant's "8pm rush" is 8pm where it stands, and a
-- UTC histogram puts a Pakistani dinner service in the small hours.
--
-- Hardcoded to Asia/Karachi today. When the first tenant outside PK needs
-- reporting, this becomes a per-tenant timezone on TenantConfig rather than a
-- literal here.
by_hour as (
  select jsonb_agg(x order by x.hour) as rows from (
    select extract(hour from created_at at time zone 'Asia/Karachi')::int as hour,
           count(*)                      as orders,
           coalesce(sum(total_amount),0) as total
      from live
     group by 1
  ) x
),
top_items as (
  select jsonb_agg(x order by x.revenue desc) as rows from (
    select i.dish_name,
           sum(i.quantity)                as quantity,
           coalesce(sum(i.item_total), 0) as revenue
      from public.order_items i
      join live o on o.id = i.order_id
     where i.voided_at is null
     group by i.dish_name
     order by revenue desc
     limit 25
  ) x
),
by_staff as (
  select jsonb_agg(x order by x.total desc) as rows from (
    select o.staff_id,
           count(*)                        as orders,
           coalesce(sum(o.total_amount),0) as total
      from live o
     where o.staff_id is not null
     group by o.staff_id
  ) x
)
select jsonb_build_object(
  'from',          p_from,
  'to',            p_to,
  'orders',        (select order_count   from totals),
  'subtotal',      (select subtotal      from totals),
  'discount',      (select discount      from totals),
  'serviceCharge', (select service_charge from totals),
  'tax',           (select tax           from totals),
  'total',         (select total         from totals),
  'averageOrder',  (select average_order from totals),
  'voidedCount',   (select n     from voided),
  'voidedValue',   (select value from voided),
  'bySource',      coalesce((select rows from by_source), '[]'::jsonb),
  'byOrderType',   coalesce((select rows from by_type),   '[]'::jsonb),
  'byTender',      coalesce((select rows from by_tender), '[]'::jsonb),
  'byHour',        coalesce((select rows from by_hour),   '[]'::jsonb),
  'topItems',      coalesce((select rows from top_items), '[]'::jsonb),
  'byStaff',       coalesce((select rows from by_staff),  '[]'::jsonb)
);
$$;

notify pgrst, 'reload schema';
