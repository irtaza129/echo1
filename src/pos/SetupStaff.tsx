import { useCallback, useEffect, useState } from 'react';
import { tenantFetch } from '../lib/apiClient';

// Staff PINs and what each person is allowed to do.
//
// Replaces scripts/set-staff-pin.ts. A manager re-issuing a PIN because someone
// wrote theirs on the monitor should not need a developer.

interface Permissions {
  can_void:         boolean;
  can_discount:     boolean;
  can_refund:       boolean;
  can_close_shift:  boolean;
  can_open_drawer:  boolean;
  max_discount_pct: number;
}

interface Staff {
  staffId:     string;
  email:       string;
  role:        string;
  hasPin:      boolean;
  permissions: Permissions;
}

const CAPABILITIES: Array<{ key: keyof Permissions; label: string; hint: string }> = [
  { key: 'can_void',        label: 'Void items',   hint: 'Remove a line from an order that is already open' },
  { key: 'can_discount',    label: 'Give discounts', hint: 'Up to their limit below' },
  { key: 'can_refund',      label: 'Refund',       hint: 'Give money back after payment' },
  { key: 'can_close_shift', label: 'Close the till', hint: 'Count the drawer and end the shift' },
  { key: 'can_open_drawer', label: 'Open the drawer', hint: 'Without a sale' },
];

export default function SetupStaff() {
  const [staff,  setStaff]  = useState<Staff[]>([]);
  const [error,  setError]  = useState<string | null>(null);
  const [ok,     setOk]     = useState<string | null>(null);
  const [busy,   setBusy]   = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await tenantFetch('/api/pos/staff');
      if (!res.ok) throw new Error(`staff ${res.status}`);
      const body = await res.json() as { staff: Staff[] };
      setStaff(body.staff);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!ok) return;
    const id = setTimeout(() => setOk(null), 3000);
    return () => clearTimeout(id);
  }, [ok]);

  async function savePin(email: string, pin: string) {
    setBusy(email); setError(null);
    try {
      const res  = await tenantFetch(`/api/pos/staff/${encodeURIComponent(email)}/pin`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ pin }),
      });
      const body = await res.json() as { error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not set the PIN'); return; }
      setOk(`PIN set for ${email}`);
      await load();
    } finally { setBusy(null); }
  }

  async function clearPin(email: string) {
    if (!window.confirm(`Remove ${email}'s PIN? They will not be able to use the till.`)) return;
    setBusy(email);
    try {
      await tenantFetch(`/api/pos/staff/${encodeURIComponent(email)}/pin`, { method: 'DELETE' });
      setOk(`PIN removed for ${email}`);
      await load();
    } finally { setBusy(null); }
  }

  async function savePermissions(email: string, permissions: Permissions) {
    setBusy(email); setError(null);
    try {
      const res  = await tenantFetch(`/api/pos/staff/${encodeURIComponent(email)}/permissions`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(permissions),
      });
      const body = await res.json() as { error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not save'); return; }
      setOk(`Permissions saved for ${email}`);
      await load();
    } finally { setBusy(null); }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">
        A PIN says <strong>who is at the till</strong>. It is not a password and gives
        no access on its own — tick what each person may do below.
      </p>

      {error && (
        <div className="px-4 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">{error}</div>
      )}
      {ok && (
        <div className="px-4 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">{ok}</div>
      )}

      {loaded && staff.length === 0 && (
        <p className="text-center text-slate-400 py-10">
          No staff yet. Invite them from the admin panel’s Staff tab, then set a PIN here.
        </p>
      )}

      {staff.map(s => (
        <StaffRow
          key={s.staffId}
          staff={s}
          busy={busy === s.email}
          onSavePin={pin => void savePin(s.email, pin)}
          onClearPin={() => void clearPin(s.email)}
          onSavePermissions={p => void savePermissions(s.email, p)}
        />
      ))}
    </div>
  );
}

function StaffRow({
  staff, busy, onSavePin, onClearPin, onSavePermissions,
}: {
  staff: Staff;
  busy: boolean;
  onSavePin: (pin: string) => void;
  onClearPin: () => void;
  onSavePermissions: (p: Permissions) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pin,  setPin]  = useState('');
  const [perm, setPerm] = useState<Permissions>(staff.permissions);

  // Keep the form in step when the list reloads after a save.
  useEffect(() => { setPerm(staff.permissions); }, [staff.permissions]);

  const dirty = JSON.stringify(perm) !== JSON.stringify(staff.permissions);

  return (
    <section className="bg-white rounded-xl border border-slate-200">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 p-3 text-left cursor-pointer"
      >
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">{staff.email}</div>
          <div className="text-xs text-slate-500">
            {staff.role.replace('_', ' ')}
            {' · '}
            {staff.hasPin
              ? <span className="text-emerald-700">PIN set</span>
              : <span className="text-amber-700">no PIN — cannot use the till</span>}
          </div>
        </div>
        <span className="text-slate-400 text-sm shrink-0">{open ? 'Close' : 'Edit'}</span>
      </button>

      {open && (
        <div className="border-t border-slate-100 p-3 space-y-4">
          {/* PIN */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">
              Till PIN
            </h4>
            <div className="flex gap-2 flex-wrap items-center">
              <input
                value={pin}
                onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                placeholder="4 digits"
                inputMode="numeric"
                className="w-32 min-h-[44px] px-3 rounded-lg border border-slate-300 tracking-[0.3em]"
              />
              <button
                onClick={() => { onSavePin(pin); setPin(''); }}
                disabled={busy || pin.length < 4}
                className="min-h-[44px] px-4 rounded-lg bg-slate-900 text-white text-sm font-semibold disabled:opacity-40 cursor-pointer"
              >
                {staff.hasPin ? 'Change PIN' : 'Set PIN'}
              </button>
              <button
                onClick={() => setPin(suggestPin())}
                className="min-h-[44px] px-3 rounded-lg border border-slate-300 text-sm cursor-pointer"
              >
                Suggest
              </button>
              {staff.hasPin && (
                <button
                  onClick={onClearPin}
                  disabled={busy}
                  className="min-h-[44px] px-3 rounded-lg text-sm text-red-600 hover:underline cursor-pointer"
                >
                  Remove
                </button>
              )}
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              Obvious PINs like 1234 or 0000 are refused. Write it down — it cannot be read back.
            </p>
          </div>

          {/* Permissions */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">
              Allowed to
            </h4>
            <div className="space-y-1.5">
              {CAPABILITIES.map(c => (
                <label key={c.key} className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={perm[c.key] === true}
                    onChange={e => setPerm(p => ({ ...p, [c.key]: e.target.checked }))}
                    className="mt-0.5 w-5 h-5 shrink-0 cursor-pointer"
                  />
                  <span className="min-w-0">
                    <span className="text-sm font-medium block">{c.label}</span>
                    <span className="text-[11px] text-slate-500">{c.hint}</span>
                  </span>
                </label>
              ))}
            </div>

            {perm.can_discount && (
              <label className="block mt-3">
                <span className="block text-xs font-semibold text-slate-600 mb-1">
                  Biggest discount they can give without a manager (%)
                </span>
                <input
                  value={String(perm.max_discount_pct)}
                  onChange={e => setPerm(p => ({
                    ...p,
                    // Clamped here and again on the server, which is the one
                    // that counts.
                    max_discount_pct: Math.min(100, Math.max(0, Number(e.target.value) || 0)),
                  }))}
                  inputMode="decimal"
                  className="w-28 min-h-[44px] px-3 rounded-lg border border-slate-300 tabular-nums"
                />
              </label>
            )}

            <button
              onClick={() => onSavePermissions(perm)}
              disabled={busy || !dirty}
              className="mt-3 min-h-[44px] px-5 rounded-lg bg-slate-900 text-white text-sm font-semibold disabled:opacity-40 cursor-pointer"
            >
              {busy ? 'Saving…' : dirty ? 'Save permissions' : 'Saved'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Suggest a PIN the server will accept.
 *
 * Uses the browser's CSPRNG rather than Math.random, and re-rolls the obvious
 * patterns the server rejects so "Suggest" never hands back something that is
 * then refused.
 */
function suggestPin(): string {
  for (;;) {
    const buf = new Uint16Array(1);
    crypto.getRandomValues(buf);
    if (buf[0] >= 60000) continue;                 // keep the distribution even
    const pin = String(buf[0] % 10000).padStart(4, '0');
    if (/^(\d)\1{3}$/.test(pin)) continue;         // 1111, 0000
    const asc  = pin.split('').every((d, i, a) => i === 0 || +d === +a[i - 1] + 1);
    const desc = pin.split('').every((d, i, a) => i === 0 || +d === +a[i - 1] - 1);
    if (asc || desc) continue;                     // 1234, 4321
    return pin;
  }
}
