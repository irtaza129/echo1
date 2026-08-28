import { useCallback, useEffect, useState } from 'react';
import { tenantFetch } from '../lib/apiClient';
import type { Operator } from './PinGate';
import ManagerApproval from './ManagerApproval';

// Taking money for one order.
//
// Multi-tender is the default shape, not a special case: "cash for most of it,
// card for the rest" is ordinary, and modelling payment as a single method is
// what forces staff to fake it later. Each tender is its own POST; the server
// answers with what is still due and whether the order is settled, and that
// answer is what this screen believes — never its own arithmetic.

type Method = 'cash' | 'card' | 'wallet' | 'bank' | 'voucher' | 'other';

interface PaymentRow {
  id: string; method: string; amount: string | number;
  tendered: string | number | null; change_due: string | number;
  refunded_amount: string | number; status: string; created_at: string;
}

interface OrderDetail {
  order: {
    id: string; order_number: number | null; status: string;
    total_amount: string | number; subtotal: string | number;
    discount: string | number; tax_total: string | number;
    service_charge: string | number; closed_at: string | null; voided_at: string | null;
  };
  items: Array<{
    id: string; dish_name: string; quantity: number;
    unit_price: string | number; item_total: string | number;
    voided_at: string | null;
    selected_options: { choice_name: string }[] | null;
  }>;
  payments: PaymentRow[];
}

const n = (v: unknown) => {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(x) ? x : 0;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

export default function PaymentDrawer({
  orderId, operator, currency, onClose, onSettled,
}: {
  orderId: string;
  operator: Operator;
  currency: string;
  onClose: () => void;
  onSettled: () => void;
}) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [method, setMethod] = useState<Method>('cash');
  const [amount, setAmount] = useState('');
  const [tendered, setTendered] = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvalFor, setApprovalFor] = useState<null | { kind: 'void'; itemId?: string } | { kind: 'discount' }>(null);

  const load = useCallback(async () => {
    try {
      const res = await tenantFetch(`/api/pos/orders/${orderId}`);
      if (!res.ok) throw new Error(`order ${res.status}`);
      setDetail(await res.json() as OrderDetail);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [orderId]);

  useEffect(() => { void load(); }, [load]);

  if (!detail) {
    return (
      <Shell onClose={onClose}>
        <p className="text-slate-500">{error ?? 'Loading…'}</p>
      </Shell>
    );
  }

  const total = n(detail.order.total_amount);
  const paid  = r2(detail.payments
    .filter(p => p.status !== 'voided')
    .reduce((s, p) => s + n(p.amount) - n(p.refunded_amount), 0));
  const due   = r2(total - paid);

  const amountNum   = Number(amount) || 0;
  const tenderedNum = Number(tendered) || 0;
  // Change is only ever real on cash. Offering it on a card payment is a
  // drawer leak, so it is not shown for one.
  const change = method === 'cash' && tenderedNum > amountNum ? r2(tenderedNum - amountNum) : 0;

  async function takePayment() {
    setBusy(true); setError(null);
    try {
      const res = await tenantFetch(`/api/pos/orders/${orderId}/payments`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method,
          amount:   amountNum,
          tendered: method === 'cash' && tenderedNum > 0 ? tenderedNum : undefined,
        }),
      });
      const body = await res.json() as { error?: string; settled?: boolean; due?: number };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);

      setAmount(''); setTendered('');
      await load();
      if (body.settled) onSettled();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const liveItems = detail.items.filter(i => !i.voided_at);

  return (
    <Shell onClose={onClose} title={`Order #${detail.order.order_number ?? '—'}`}>
      <div className="grid md:grid-cols-2 gap-4">
        {/* Lines */}
        <section>
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Items</h3>
          <ul className="space-y-1 text-sm mb-3">
            {liveItems.map(i => (
              <li key={i.id} className="flex justify-between gap-2 items-start">
                <span className="min-w-0">
                  <span className="truncate block">{i.quantity}× {i.dish_name}</span>
                  {i.selected_options && i.selected_options.length > 0 && (
                    <span className="text-[11px] text-slate-500">
                      {i.selected_options.map(o => o.choice_name).join(', ')}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="tabular-nums">{n(i.item_total).toFixed(2)}</span>
                  {operator.permissions.can_void && !detail.order.closed_at && (
                    <button
                      onClick={() => setApprovalFor({ kind: 'void', itemId: i.id })}
                      className="text-[11px] text-red-600 hover:underline cursor-pointer"
                    >
                      void
                    </button>
                  )}
                </span>
              </li>
            ))}
            {detail.items.some(i => i.voided_at) && (
              <li className="text-[11px] text-slate-400 pt-1">
                {detail.items.filter(i => i.voided_at).length} voided line(s) hidden
              </li>
            )}
          </ul>

          <div className="text-sm space-y-1 border-t border-slate-100 pt-2">
            <Row label="Subtotal" value={n(detail.order.subtotal)} currency={currency} />
            {n(detail.order.discount)       > 0 && <Row label="Discount"       value={-n(detail.order.discount)} currency={currency} />}
            {n(detail.order.service_charge) > 0 && <Row label="Service charge" value={n(detail.order.service_charge)} currency={currency} />}
            {n(detail.order.tax_total)      > 0 && <Row label="Tax"            value={n(detail.order.tax_total)} currency={currency} />}
            <Row label="Total" value={total} currency={currency} bold />
            <Row label="Paid"  value={paid}  currency={currency} />
            <Row label="Due"   value={due}   currency={currency} bold />
          </div>

          {operator.permissions.can_discount && !detail.order.closed_at && due > 0 && (
            <button
              onClick={() => setApprovalFor({ kind: 'discount' })}
              className="mt-2 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              Apply discount
            </button>
          )}
        </section>

        {/* Tender */}
        <section>
          {due <= 0.001 ? (
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-center">
              <p className="font-bold text-emerald-800">Settled</p>
              <p className="text-xs text-emerald-700 mt-1">
                This order is fully paid. {currency} {total.toFixed(2)} taken.
              </p>
            </div>
          ) : (
            <>
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Take payment</h3>

              <div className="grid grid-cols-3 gap-2 mb-3">
                {(['cash', 'card', 'wallet', 'bank', 'voucher', 'other'] as Method[]).map(m => (
                  <button
                    key={m}
                    onClick={() => setMethod(m)}
                    className={`min-h-[44px] rounded-lg border text-sm font-semibold capitalize transition cursor-pointer ${
                      method === m ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-300'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>

              <label className="block text-xs font-semibold text-slate-600 mb-1">Amount</label>
              <div className="flex gap-2 mb-2">
                <input
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  inputMode="decimal"
                  placeholder={due.toFixed(2)}
                  className="flex-1 min-h-[44px] px-3 rounded-lg border border-slate-300 tabular-nums"
                />
                <button
                  onClick={() => setAmount(due.toFixed(2))}
                  className="min-h-[44px] px-3 rounded-lg border border-slate-300 text-sm font-semibold cursor-pointer"
                >
                  Full
                </button>
              </div>

              {method === 'cash' && (
                <>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Cash received</label>
                  <input
                    value={tendered}
                    onChange={e => setTendered(e.target.value)}
                    inputMode="decimal"
                    className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 mb-2 tabular-nums"
                  />
                  <div className="flex gap-2 mb-2">
                    {quickCash(due).map(v => (
                      <button
                        key={v}
                        onClick={() => { setAmount(due.toFixed(2)); setTendered(String(v)); }}
                        className="flex-1 min-h-[40px] rounded-lg border border-slate-300 text-sm tabular-nums cursor-pointer"
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                  {change > 0 && (
                    <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 mb-2 text-center">
                      <p className="text-xs text-amber-800">Change</p>
                      <p className="text-2xl font-bold text-amber-900 tabular-nums">
                        {currency} {change.toFixed(2)}
                      </p>
                    </div>
                  )}
                </>
              )}

              {error && <p className="text-sm text-red-700 mb-2">{error}</p>}

              <button
                onClick={() => void takePayment()}
                disabled={busy || amountNum <= 0}
                className="w-full min-h-[48px] rounded-xl bg-slate-900 text-white font-semibold disabled:opacity-40 cursor-pointer"
              >
                {busy ? 'Taking…' : `Take ${currency} ${(amountNum || 0).toFixed(2)}`}
              </button>
            </>
          )}

          {detail.payments.length > 0 && (
            <div className="mt-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Tenders</h3>
              <ul className="text-sm space-y-1">
                {detail.payments.map(p => (
                  <li key={p.id} className="flex justify-between gap-2">
                    <span className="capitalize">
                      {p.method}
                      {n(p.refunded_amount) > 0 && (
                        <span className="text-red-600 text-xs ml-1">
                          −{n(p.refunded_amount).toFixed(2)} refunded
                        </span>
                      )}
                    </span>
                    <span className="tabular-nums">{n(p.amount).toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>

      {approvalFor && (
        <ManagerApproval
          orderId={orderId}
          intent={approvalFor}
          currency={currency}
          onCancel={() => setApprovalFor(null)}
          onDone={async () => { setApprovalFor(null); await load(); }}
        />
      )}
    </Shell>
  );
}

// Round up to notes a person actually carries, so the cashier taps once rather
// than typing. Anything at or below the amount due is useless as a shortcut.
function quickCash(due: number): number[] {
  const steps = [50, 100, 500, 1000, 5000];
  const out: number[] = [];
  for (const s of steps) {
    const v = Math.ceil(due / s) * s;
    if (v > due && !out.includes(v)) out.push(v);
    if (out.length === 3) break;
  }
  return out;
}

function Row({ label, value, currency, bold }: {
  label: string; value: number; currency: string; bold?: boolean;
}) {
  return (
    <div className={`flex justify-between ${bold ? 'font-bold' : 'text-slate-600'}`}>
      <span>{label}</span>
      <span className="tabular-nums">{currency} {value.toFixed(2)}</span>
    </div>
  );
}

function Shell({ children, onClose, title }: {
  children: React.ReactNode; onClose: () => void; title?: string;
}) {
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-3xl rounded-t-2xl sm:rounded-2xl max-h-[92vh] flex flex-col">
        <header className="flex items-center justify-between gap-4 p-4 border-b border-slate-100 shrink-0">
          <h2 className="font-bold">{title ?? 'Payment'}</h2>
          <button onClick={onClose} className="min-h-[44px] px-4 rounded-lg border border-slate-300 font-semibold cursor-pointer">
            Close
          </button>
        </header>
        <div className="flex-1 overflow-auto p-4">{children}</div>
      </div>
    </div>
  );
}
