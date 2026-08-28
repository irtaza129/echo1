import * as db from './supabaseAdmin.js';

// Sales reporting.
//
// One RPC call to `pos_report_summary` (migration 016) returns the whole
// document. The aggregation is deliberately in Postgres — see the migration for
// why — so this file is a typed wrapper and a CSV writer, nothing more.

export interface SalesReport {
  from: string;
  to:   string;

  orders:        number;
  subtotal:      number;
  discount:      number;
  serviceCharge: number;
  tax:           number;
  total:         number;
  averageOrder:  number;

  /** Voids are excluded from the money above but counted here — thirty voids in a day means something. */
  voidedCount: number;
  voidedValue: number;

  bySource:    Array<{ source: string; orders: number; total: number }>;
  byOrderType: Array<{ order_type: string; orders: number; total: number }>;
  byTender:    Array<{ method: string; count: number; gross: number; refunded: number; net: number }>;
  byHour:      Array<{ hour: number; orders: number; total: number }>;
  topItems:    Array<{ dish_name: string; quantity: number; revenue: number }>;
  byStaff:     Array<{ staff_id: string; orders: number; total: number }>;
}

// PostgREST returns numerics as strings in some shapes and numbers in others.
// Coerce once at the boundary so no caller does arithmetic on "1214.56".
const n = (v: unknown): number => {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(x) ? x : 0;
};

export const reportsRepo = {
  async summary(tenantId: string, from: string, to: string): Promise<SalesReport> {
    const raw = await db.rpc<Record<string, unknown>>('pos_report_summary', {
      p_tenant: tenantId, p_from: from, p_to: to,
    });

    const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);

    return {
      from: String(raw.from ?? from),
      to:   String(raw.to   ?? to),

      orders:        n(raw.orders),
      subtotal:      n(raw.subtotal),
      discount:      n(raw.discount),
      serviceCharge: n(raw.serviceCharge),
      tax:           n(raw.tax),
      total:         n(raw.total),
      averageOrder:  n(raw.averageOrder),
      voidedCount:   n(raw.voidedCount),
      voidedValue:   n(raw.voidedValue),

      bySource:    arr<Record<string, unknown>>(raw.bySource)
        .map(r => ({ source: String(r.source), orders: n(r.orders), total: n(r.total) })),
      byOrderType: arr<Record<string, unknown>>(raw.byOrderType)
        .map(r => ({ order_type: String(r.order_type), orders: n(r.orders), total: n(r.total) })),
      byTender:    arr<Record<string, unknown>>(raw.byTender)
        .map(r => ({
          method: String(r.method), count: n(r.count),
          gross: n(r.gross), refunded: n(r.refunded), net: n(r.net),
        })),
      byHour:      arr<Record<string, unknown>>(raw.byHour)
        .map(r => ({ hour: n(r.hour), orders: n(r.orders), total: n(r.total) })),
      topItems:    arr<Record<string, unknown>>(raw.topItems)
        .map(r => ({ dish_name: String(r.dish_name), quantity: n(r.quantity), revenue: n(r.revenue) })),
      byStaff:     arr<Record<string, unknown>>(raw.byStaff)
        .map(r => ({ staff_id: String(r.staff_id), orders: n(r.orders), total: n(r.total) })),
    };
  },
};

/**
 * Escape one CSV field.
 *
 * A leading =, +, - or @ is prefixed with a quote. Excel and Sheets interpret
 * those as formulas, so a dish literally named "=Special" becomes an executable
 * cell in a file a manager opens without thinking — the CSV injection problem.
 * The quote makes it inert and is invisible in the cell.
 */
function csvField(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRows(rows: (unknown[])[]): string {
  // CRLF, because that is what the CSV spec says and what Excel expects.
  return rows.map(r => r.map(csvField).join(',')).join('\r\n');
}

/**
 * A single flat CSV covering the whole report.
 *
 * Sectioned rather than one table per file: a manager opening this wants every
 * figure in one place, and a zip of six files is a worse answer than a sheet
 * they can scroll.
 */
export function toCsv(r: SalesReport): string {
  const rows: (unknown[])[] = [];

  rows.push(['Sales report']);
  rows.push(['From', r.from]);
  rows.push(['To',   r.to]);
  rows.push([]);

  rows.push(['Summary']);
  rows.push(['Orders',         r.orders]);
  rows.push(['Subtotal',       r.subtotal]);
  rows.push(['Discount',       r.discount]);
  rows.push(['Service charge', r.serviceCharge]);
  rows.push(['Tax',            r.tax]);
  rows.push(['Total',          r.total]);
  rows.push(['Average order',  r.averageOrder]);
  rows.push(['Voided orders',  r.voidedCount]);
  rows.push(['Voided value',   r.voidedValue]);
  rows.push([]);

  rows.push(['Channel', 'Orders', 'Total']);
  for (const s of r.bySource) rows.push([s.source, s.orders, s.total]);
  rows.push([]);

  rows.push(['Order type', 'Orders', 'Total']);
  for (const t of r.byOrderType) rows.push([t.order_type, t.orders, t.total]);
  rows.push([]);

  rows.push(['Tender', 'Count', 'Gross', 'Refunded', 'Net']);
  for (const t of r.byTender) rows.push([t.method, t.count, t.gross, t.refunded, t.net]);
  rows.push([]);

  rows.push(['Hour', 'Orders', 'Total']);
  for (const h of r.byHour) rows.push([h.hour, h.orders, h.total]);
  rows.push([]);

  rows.push(['Item', 'Quantity', 'Revenue']);
  for (const i of r.topItems) rows.push([i.dish_name, i.quantity, i.revenue]);

  return csvRows(rows);
}
