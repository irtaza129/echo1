import { useState } from 'react';
import { tenantFetch } from '../lib/apiClient';

// The "get a manager" modal.
//
// It collects a reason and a PIN and posts both. It does NOT decide whether the
// person is allowed — the server re-identifies the PIN and checks that
// operator's stored permissions, including their discount ceiling. This
// component could be bypassed entirely with curl and the rule would still hold;
// that is the point.
//
// The reason is mandatory and free-text on purpose. A dropdown of canned
// reasons gets one option picked for everything within a week, and "wrong
// order" then explains nothing at the end-of-month review.

export type Intent =
  | { kind: 'void'; itemId?: string }
  | { kind: 'discount' };

export default function ManagerApproval({
  orderId, intent, currency, onCancel, onDone,
}: {
  orderId:  string;
  intent:   Intent;
  currency: string;
  onCancel: () => void;
  onDone:   () => void | Promise<void>;
}) {
  const [reason,   setReason]   = useState('');
  const [discount, setDiscount] = useState('');
  const [pin,      setPin]      = useState('');
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  const isDiscount = intent.kind === 'discount';
  const title      = isDiscount ? 'Apply a discount' : 'Void this line';

  async function submit() {
    setBusy(true); setError(null);
    try {
      const url = isDiscount
        ? `/api/pos/orders/${orderId}/discount`
        : `/api/pos/orders/${orderId}/items/${(intent as { itemId: string }).itemId}/void`;

      const body = isDiscount
        ? { discount: Number(discount) || 0, reason, approvalPin: pin }
        : { reason, approvalPin: pin };

      const res  = await tenantFetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const json = await res.json() as { error?: string; approvedBy?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);

      await onDone();
    } catch (err) {
      // The PIN is cleared on any failure so a refused attempt cannot be
      // retried by just tapping the button again.
      setPin('');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const ready = reason.trim().length > 0
    && pin.length >= 4
    && (!isDiscount || Number(discount) > 0);

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white w-full max-w-sm rounded-2xl p-4">
        <h2 className="font-bold mb-1">{title}</h2>
        <p className="text-xs text-slate-500 mb-4">
          A manager must authorise this. It is recorded against their name.
        </p>

        {isDiscount && (
          <>
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              Discount amount ({currency})
            </label>
            <input
              value={discount}
              onChange={e => setDiscount(e.target.value)}
              inputMode="decimal"
              className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 mb-3 tabular-nums"
            />
          </>
        )}

        <label className="block text-xs font-semibold text-slate-600 mb-1">Reason</label>
        <input
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder={isDiscount ? 'e.g. regular customer' : 'e.g. sent back, wrong dish'}
          className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 mb-3"
        />

        <label className="block text-xs font-semibold text-slate-600 mb-1">Manager PIN</label>
        <input
          value={pin}
          onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 mb-3 tracking-[0.4em]"
        />

        {error && <p className="text-sm text-red-700 mb-3">{error}</p>}

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 min-h-[48px] rounded-xl border border-slate-300 font-semibold cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !ready}
            className="flex-1 min-h-[48px] rounded-xl bg-slate-900 text-white font-semibold disabled:opacity-40 cursor-pointer"
          >
            {busy ? 'Checking…' : 'Authorise'}
          </button>
        </div>
      </div>
    </div>
  );
}
