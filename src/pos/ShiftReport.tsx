import { useCallback, useEffect, useState } from 'react';
import { tenantFetch } from '../lib/apiClient';

// X and Z reports.
//
// X = read the figures mid-shift; the drawer stays open and nothing changes.
// Z = the same figures at close, after the cash has been counted.
//
// They are the same endpoint and the same computation, which matters: a Z that
// is derived differently from the X staff read an hour earlier is a Z nobody
// trusts. The only difference is that a Z has a counted figure to compare
// against, and the shift is finished afterwards.

interface Report {
  shiftId: string;
  openedAt: string;
  closedAt: string | null;
  openingFloat: number;
  orders: { total: number; voided: number };
  sales: { subtotal: number; discount: number; serviceCharge: number; tax: number; total: number };
  tenders: Array<{ method: string; gross: number; refunded: number; net: number; count: number }>;
  movements: Array<{ type: string; amount: number; count: number }>;
  expectedCash: number;
  declaredCash: number | null;
  variance: number | null;
}

export default function ShiftReport({
  shiftId, currency, canClose, onClosed,
}: {
  shiftId:  string;
  currency: string;
  canClose: boolean;
  onClosed: () => void | Promise<void>;
}) {
  const [report,   setReport]   = useState<Report | null>(null);
  const [kind,     setKind]     = useState<'X' | 'Z'>('X');
  const [open,     setOpen]     = useState(false);
  const [counted,  setCounted]  = useState('');
  const [note,     setNote]     = useState('');
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await tenantFetch(`/api/pos/shifts/${shiftId}/report`);
      if (!res.ok) throw new Error(`report ${res.status}`);
      const body = await res.json() as { report: Report; kind: 'X' | 'Z' };
      setReport(body.report);
      setKind(body.kind);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [shiftId]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  async function closeShift() {
    setBusy(true); setError(null);
    try {
      const res = await tenantFetch(`/api/pos/shifts/${shiftId}/close`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ declaredCash: Number(counted) || 0, note: note || null }),
      });
      const body = await res.json() as { error?: string; openOrders?: number };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      await load();
      await onClosed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full min-h-[44px] rounded-lg border border-slate-300 text-sm font-semibold hover:bg-slate-50 cursor-pointer"
      >
        Read X report
      </button>
    );
  }

  const money = (v: number) => `${currency} ${v.toFixed(2)}`;
  // Counting is blind until a figure is typed: showing "expected" next to the
  // input invites the counter to type that number instead of counting.
  const countedNum = Number(counted);
  const preview    = report && counted !== '' && Number.isFinite(countedNum)
    ? Math.round((countedNum - report.expectedCash) * 100) / 100
    : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-sm">{kind} report</h3>
        <button onClick={() => setOpen(false)} className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer">
          Hide
        </button>
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      {!report && !error && <p className="text-sm text-slate-500">Loading…</p>}

      {report && (
        <>
          <Block title="Sales">
            <Row label="Orders"         value={String(report.orders.total)} />
            {report.orders.voided > 0 && <Row label="of which voided" value={String(report.orders.voided)} warn />}
            <Row label="Subtotal"       value={money(report.sales.subtotal)} />
            {report.sales.discount      > 0 && <Row label="Discounts"      value={`− ${money(report.sales.discount)}`} warn />}
            {report.sales.serviceCharge > 0 && <Row label="Service charge" value={money(report.sales.serviceCharge)} />}
            {report.sales.tax           > 0 && <Row label="Tax"            value={money(report.sales.tax)} />}
            <Row label="Total" value={money(report.sales.total)} bold />
          </Block>

          {report.tenders.length > 0 && (
            <Block title="Tenders">
              {report.tenders.map(t => (
                <Row
                  key={t.method}
                  label={`${t.method} (${t.count})`}
                  value={t.refunded > 0
                    ? `${money(t.net)}  (−${t.refunded.toFixed(2)})`
                    : money(t.net)}
                />
              ))}
            </Block>
          )}

          {report.movements.length > 0 && (
            <Block title="Cash movements">
              {report.movements.map(m => (
                <Row key={m.type} label={`${m.type.replace('_', ' ')} (${m.count})`} value={money(m.amount)} />
              ))}
            </Block>
          )}

          <Block title="Drawer">
            <Row label="Opening float" value={money(report.openingFloat)} />
            <Row label="Expected cash" value={money(report.expectedCash)} bold />
            {report.declaredCash !== null && (
              <>
                <Row label="Counted"  value={money(report.declaredCash)} />
                <Row
                  label="Variance"
                  value={money(report.variance ?? 0)}
                  warn={Math.abs(report.variance ?? 0) > 0.001}
                  bold
                />
              </>
            )}
          </Block>

          {kind === 'X' && canClose && (
            <div className="pt-2 border-t border-slate-100 space-y-2">
              <label className="block text-xs font-semibold text-slate-600">Counted cash</label>
              <input
                value={counted}
                onChange={e => setCounted(e.target.value)}
                inputMode="decimal"
                placeholder="Count the drawer, then enter the total"
                className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 tabular-nums"
              />
              <input
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="Note (optional)"
                className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300"
              />

              {preview !== null && (
                <p className={`text-sm font-semibold ${Math.abs(preview) < 0.001 ? 'text-emerald-700' : 'text-amber-700'}`}>
                  {Math.abs(preview) < 0.001
                    ? 'Balances exactly.'
                    : `${preview > 0 ? 'Over' : 'Short'} by ${money(Math.abs(preview))}`}
                </p>
              )}

              <button
                onClick={() => void closeShift()}
                disabled={busy || counted === ''}
                className="w-full min-h-[48px] rounded-xl bg-slate-900 text-white font-semibold disabled:opacity-40 cursor-pointer"
              >
                {busy ? 'Closing…' : 'Close shift'}
              </button>
              <p className="text-[11px] text-slate-500">
                Every open tab must be settled or voided before the drawer can close.
              </p>
            </div>
          )}

          {kind === 'X' && !canClose && (
            <p className="text-xs text-slate-500 pt-2 border-t border-slate-100">
              You do not have permission to close a shift. Ask a manager.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{title}</h4>
      <div className="space-y-0.5 text-sm">{children}</div>
    </section>
  );
}

function Row({ label, value, bold, warn }: {
  label: string; value: string; bold?: boolean; warn?: boolean;
}) {
  return (
    <div className={`flex justify-between gap-4 ${bold ? 'font-bold' : ''} ${warn ? 'text-amber-700' : bold ? '' : 'text-slate-600'}`}>
      <span className="capitalize">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
