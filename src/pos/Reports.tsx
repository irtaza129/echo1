import { useCallback, useEffect, useMemo, useState } from 'react';
import { tenantFetch } from '../lib/apiClient';

// Sales reporting.
//
// The figure this screen exists for is channel attribution: whether the kiosk,
// the phone agent and the table QR are actually selling anything, or whether
// every order still comes from the till. Everything else is context for it.

interface SalesReport {
  from: string; to: string;
  orders: number; subtotal: number; discount: number; serviceCharge: number;
  tax: number; total: number; averageOrder: number;
  voidedCount: number; voidedValue: number;
  bySource:    Array<{ source: string; orders: number; total: number }>;
  byOrderType: Array<{ order_type: string; orders: number; total: number }>;
  byTender:    Array<{ method: string; count: number; gross: number; refunded: number; net: number }>;
  byHour:      Array<{ hour: number; orders: number; total: number }>;
  topItems:    Array<{ dish_name: string; quantity: number; revenue: number }>;
}

const SOURCE_LABEL: Record<string, string> = {
  pos: 'Till', kiosk: 'Kiosk', phone: 'Phone', whatsapp: 'WhatsApp', qr: 'Table QR', web: 'Web',
};

function localDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type Preset = 'today' | 'week' | 'month' | 'custom';

export default function Reports({ currency }: { currency: string }) {
  const [preset, setPreset] = useState<Preset>('today');
  const [from,   setFrom]   = useState(localDay());
  const [to,     setTo]     = useState(localDay());
  const [report, setReport] = useState<SalesReport | null>(null);
  const [error,  setError]  = useState<string | null>(null);
  const [busy,   setBusy]   = useState(false);

  function applyPreset(p: Preset) {
    setPreset(p);
    if (p === 'today') { setFrom(localDay());    setTo(localDay()); }
    if (p === 'week')  { setFrom(localDay(-6));  setTo(localDay()); }
    if (p === 'month') { setFrom(localDay(-29)); setTo(localDay()); }
  }

  // Local midnight to local midnight, sent as instants. Using UTC boundaries
  // would put a Pakistani evening service on the wrong day — the exact hours a
  // restaurant most wants counted.
  const range = useMemo(() => ({
    from: new Date(`${from}T00:00:00`).toISOString(),
    to:   new Date(`${to}T23:59:59.999`).toISOString(),
  }), [from, to]);

  const load = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const qs  = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
      const res = await tenantFetch(`/api/pos/reports/summary?${qs}`);
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }
      setReport(await res.json() as SalesReport);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setReport(null);
    } finally {
      setBusy(false);
    }
  }, [range]);

  useEffect(() => { void load(); }, [load]);

  async function exportCsv() {
    const qs  = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
    const res = await tenantFetch(`/api/pos/reports/summary.csv?${qs}`);
    if (!res.ok) { setError('Export failed'); return; }

    // Fetched rather than linked because the request needs an Authorization
    // header, which a plain <a download> cannot send.
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `sales-${from}_to_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const money = (v: number) => `${currency} ${v.toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

  const peakHour = useMemo(
    () => report?.byHour.reduce<{ hour: number; total: number } | null>(
      (best, h) => (!best || h.total > best.total ? h : best), null),
    [report],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 flex items-center gap-2 mb-3 flex-wrap">
        {(['today', 'week', 'month'] as const).map(p => (
          <button
            key={p}
            onClick={() => applyPreset(p)}
            className={`min-h-[44px] px-4 rounded-xl text-sm font-bold border capitalize cursor-pointer ${
              preset === p ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-300'
            }`}
          >
            {p === 'week' ? 'Last 7 days' : p === 'month' ? 'Last 30 days' : 'Today'}
          </button>
        ))}

        <input
          type="date" value={from}
          onChange={e => { setFrom(e.target.value); setPreset('custom'); }}
          className="min-h-[44px] px-3 rounded-xl border border-slate-300"
        />
        <span className="text-slate-400">to</span>
        <input
          type="date" value={to}
          onChange={e => { setTo(e.target.value); setPreset('custom'); }}
          className="min-h-[44px] px-3 rounded-xl border border-slate-300"
        />

        <button
          onClick={() => void exportCsv()}
          disabled={!report}
          className="ml-auto min-h-[44px] px-4 rounded-xl border border-slate-300 text-sm font-semibold disabled:opacity-40 cursor-pointer"
        >
          Export CSV
        </button>
      </div>

      {error && (
        <div className="shrink-0 mb-3 px-4 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {busy && !report && <p className="text-slate-500">Loading…</p>}

        {report && report.orders === 0 && (
          <p className="text-center text-slate-400 mt-16">No sales in this period.</p>
        )}

        {report && report.orders > 0 && (
          <div className="space-y-4">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
              <Stat label="Sales"        value={money(report.total)} big />
              <Stat label="Orders"       value={String(report.orders)} />
              <Stat label="Average"      value={money(report.averageOrder)} />
              {peakHour && <Stat label="Busiest hour" value={`${peakHour.hour}:00`} />}
              {report.voidedCount > 0 && (
                <Stat label="Voided" value={`${report.voidedCount} · ${money(report.voidedValue)}`} warn />
              )}
            </div>

            {/* The point of the screen. */}
            <Panel title="Where orders came from">
              <Bars
                rows={report.bySource.map(s => ({
                  label: SOURCE_LABEL[s.source] ?? s.source,
                  count: s.orders,
                  value: s.total,
                }))}
                total={report.total}
                money={money}
              />
            </Panel>

            <div className="grid md:grid-cols-2 gap-4">
              <Panel title="Order type">
                <Bars
                  rows={report.byOrderType.map(t => ({
                    label: t.order_type.replace('_', ' '),
                    count: t.orders,
                    value: t.total,
                  }))}
                  total={report.total}
                  money={money}
                />
              </Panel>

              <Panel title="How they paid">
                {report.byTender.length === 0
                  ? <Muted>No tenders recorded — these orders were not settled through the till.</Muted>
                  : (
                    <ul className="text-sm space-y-1">
                      {report.byTender.map(t => (
                        <li key={t.method} className="flex justify-between gap-3">
                          <span className="capitalize">{t.method} <span className="text-slate-400">×{t.count}</span></span>
                          <span className="tabular-nums">
                            {money(t.net)}
                            {t.refunded > 0 && (
                              <span className="text-red-600 text-xs ml-1">−{money(t.refunded)}</span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
              </Panel>
            </div>

            <Panel title="By hour">
              <Histogram rows={report.byHour} money={money} />
            </Panel>

            <Panel title="Best sellers">
              <ul className="text-sm divide-y divide-slate-100">
                {report.topItems.slice(0, 15).map(i => (
                  <li key={i.dish_name} className="flex justify-between gap-3 py-1.5">
                    <span className="truncate">
                      <span className="text-slate-400 tabular-nums mr-2">{i.quantity}×</span>
                      {i.dish_name}
                    </span>
                    <span className="tabular-nums shrink-0">{money(i.revenue)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}

// ── bits ─────────────────────────────────────────────────────────────────────

function Stat({ label, value, big, warn }: {
  label: string; value: string; big?: boolean; warn?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-3 ${warn ? 'bg-amber-50 border-amber-200' : 'bg-white border-slate-200'}`}>
      <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{label}</div>
      <div className={`${big ? 'text-2xl' : 'text-lg'} font-bold tabular-nums leading-tight mt-0.5`}>
        {value}
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-slate-200 p-4">
      <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3">{title}</h3>
      {children}
    </section>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-slate-400">{children}</p>;
}

/** Share-of-total bars. Percentages beat raw totals for "is this channel working?". */
function Bars({ rows, total, money }: {
  rows: Array<{ label: string; count: number; value: number }>;
  total: number;
  money: (v: number) => string;
}) {
  if (rows.length === 0) return <Muted>Nothing in this period.</Muted>;

  return (
    <ul className="space-y-2">
      {rows.map(r => {
        const pct = total > 0 ? (r.value / total) * 100 : 0;
        return (
          <li key={r.label}>
            <div className="flex justify-between text-sm mb-0.5">
              <span className="capitalize">
                {r.label} <span className="text-slate-400">×{r.count}</span>
              </span>
              <span className="tabular-nums">
                {money(r.value)} <span className="text-slate-400">{pct.toFixed(0)}%</span>
              </span>
            </div>
            <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full bg-slate-900 rounded-full" style={{ width: `${pct}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Trading by hour, over a full 24.
 *
 * Empty hours are drawn, not skipped: the shape of a service — and the gap in
 * the middle of the afternoon — is the information. A chart of only the busy
 * hours looks like a restaurant that never closes.
 */
function Histogram({ rows, money }: {
  rows: Array<{ hour: number; orders: number; total: number }>;
  money: (v: number) => string;
}) {
  const byHour = new Map(rows.map(r => [r.hour, r]));
  const max    = Math.max(1, ...rows.map(r => r.total));

  return (
    <div className="flex items-end gap-0.5 h-32">
      {Array.from({ length: 24 }, (_, h) => {
        const r   = byHour.get(h);
        const pct = r ? (r.total / max) * 100 : 0;
        return (
          <div key={h} className="flex-1 flex flex-col items-center justify-end h-full group relative">
            <div
              className={`w-full rounded-t ${r ? 'bg-slate-900' : 'bg-slate-100'}`}
              style={{ height: `${Math.max(pct, r ? 4 : 2)}%` }}
              title={r ? `${h}:00 — ${r.orders} orders, ${money(r.total)}` : `${h}:00 — nothing`}
            />
            {h % 6 === 0 && (
              <span className="text-[9px] text-slate-400 mt-1 tabular-nums">{h}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
