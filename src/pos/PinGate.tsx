import { useCallback, useEffect, useState } from 'react';
import { tenantFetch, getCurrentRole } from '../lib/apiClient';
import type { PosPermissions } from '../lib/staffRepo';

// Operator identification at the till.
//
// The terminal is already authenticated as the tenant; this does not log anyone
// in. It answers "who is standing here right now", so the right staff_id lands
// on the order and so privileged actions can be attributed. Switching operator
// between covers is expected to take two seconds, which is why it is a keypad
// and not an email and password.

export interface Operator {
  staffId:     string;
  email:       string;
  role:        string;
  permissions: PosPermissions;
}

const PIN_LENGTH = 4;

export default function PinGate({
  onIdentified, onCancel,
}: {
  onIdentified: (op: Operator) => void;
  onCancel: () => void;
}) {
  const [pin,       setPin]       = useState('');
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  // requireFeature('pos') answers 403 with { feature: 'pos' } when the account
  // has never turned the Till on. That used to be a dead end fixable only from
  // a terminal; this screen now offers the fix in place.
  const [notEnabled, setNotEnabled] = useState(false);
  const [enabling,    setEnabling]  = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);

  const isAdmin = ['tenant_admin', 'super_admin'].includes(getCurrentRole() ?? '');

  const submit = useCallback(async (value: string) => {
    setBusy(true); setError(null);
    try {
      const res  = await tenantFetch('/api/pos/pin-login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ pin: value }),
      });
      const body = await res.json() as
        { error?: string; feature?: string; attemptsRemaining?: number } & Operator;

      if (!res.ok) {
        if (res.status === 403 && body.feature === 'pos') {
          setNotEnabled(true);
          setPin('');
          return;
        }
        setError(body.error ?? `Sign-in failed (${res.status})`);
        setRemaining(body.attemptsRemaining ?? null);
        setPin('');
        return;
      }

      setRemaining(null);
      onIdentified({
        staffId:     body.staffId,
        email:       body.email,
        role:        body.role,
        permissions: body.permissions,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPin('');
    } finally {
      setBusy(false);
    }
  }, [onIdentified]);

  // Auto-submit on the last digit: a cashier should never have to reach for a
  // separate confirm key forty times a shift.
  useEffect(() => {
    if (pin.length === PIN_LENGTH && !busy && !notEnabled) void submit(pin);
  }, [pin, busy, notEnabled, submit]);

  // The terminal is a fixed screen, but a USB numeric keypad is common and
  // costs nothing to support.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (busy || notEnabled) return;
      if (/^\d$/.test(e.key))                       setPin(p => (p.length < PIN_LENGTH ? p + e.key : p));
      else if (e.key === 'Backspace')               setPin(p => p.slice(0, -1));
      else if (e.key === 'Escape')                  setPin('');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, notEnabled]);

  const press = (d: string) => setPin(p => (p.length < PIN_LENGTH ? p + d : p));

  async function turnOnTill() {
    setEnabling(true); setEnableError(null);
    try {
      // Read the whole config, flip the one field, save the whole thing back —
      // the same pattern SetupModules uses, so this button and that screen can
      // never disagree with each other.
      const cfgRes = await tenantFetch('/api/admin/my-config');
      if (!cfgRes.ok) throw new Error(`Could not read settings (${cfgRes.status})`);
      const config = await cfgRes.json() as Record<string, unknown> & {
        features?: Record<string, unknown>;
        adapter?:  Record<string, unknown>;
      };

      const res = await tenantFetch('/api/admin/save-config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...config,
          features: { ...config.features, pos: true },
          // Same invariant as the Setup screen: the Till always keeps its own
          // orders in our database, so turning it on switches ordering to match
          // — otherwise the till and the ordering channels would keep two order
          // lists that never agree.
          adapter: { ...config.adapter, type: 'pos' },
        }),
      });
      const body = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? 'Could not save');

      setNotEnabled(false);
    } catch (err) {
      setEnableError(err instanceof Error ? err.message : String(err));
    } finally {
      setEnabling(false);
    }
  }

  if (notEnabled) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-slate-100 p-6">
        <div className="w-full max-w-sm text-center">
          <h1 className="font-bold text-slate-900 mb-1">The Till isn't turned on yet</h1>
          <p className="text-sm text-slate-500 mb-5">
            {isAdmin
              ? 'One-time setup — this takes a second and only needs doing once.'
              : 'Ask an account admin to turn it on in Setup, or from here if they are signed in.'}
          </p>

          {enableError && <p className="text-sm text-red-700 mb-3">{enableError}</p>}

          {isAdmin && (
            <button
              onClick={() => void turnOnTill()}
              disabled={enabling}
              className="w-full min-h-[52px] rounded-xl bg-slate-900 text-white font-bold disabled:opacity-40 cursor-pointer mb-2"
            >
              {enabling ? 'Turning on…' : 'Turn on the Till'}
            </button>
          )}

          <button
            onClick={onCancel}
            className="w-full min-h-[44px] text-sm font-semibold text-slate-500 hover:text-slate-800 cursor-pointer"
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full bg-slate-100 p-6">
      <div className="w-full max-w-xs">
        <h1 className="text-center font-bold text-slate-900 mb-1">Enter your PIN</h1>
        <p className="text-center text-xs text-slate-500 mb-5">
          This records who rings in each order.
        </p>

        <div className="flex justify-center gap-3 mb-5" aria-live="polite">
          {Array.from({ length: PIN_LENGTH }, (_, i) => (
            <span
              key={i}
              className={`w-4 h-4 rounded-full border-2 transition ${
                i < pin.length ? 'bg-slate-900 border-slate-900' : 'border-slate-300'
              }`}
            />
          ))}
        </div>

        {error && (
          <p className="text-center text-sm text-red-700 mb-3">
            {error}
            {remaining !== null && remaining > 0 && (
              <span className="block text-xs text-red-600">
                {remaining} attempt{remaining === 1 ? '' : 's'} left before this till locks briefly.
              </span>
            )}
          </p>
        )}

        <div className="grid grid-cols-3 gap-2">
          {['1','2','3','4','5','6','7','8','9'].map(d => (
            <KeypadButton key={d} onClick={() => press(d)} disabled={busy}>{d}</KeypadButton>
          ))}
          <KeypadButton onClick={() => setPin('')} disabled={busy} muted>Clear</KeypadButton>
          <KeypadButton onClick={() => press('0')} disabled={busy}>0</KeypadButton>
          <KeypadButton onClick={() => setPin(p => p.slice(0, -1))} disabled={busy} muted>←</KeypadButton>
        </div>

        <button
          onClick={onCancel}
          className="w-full mt-4 min-h-[44px] text-sm font-semibold text-slate-500 hover:text-slate-800 cursor-pointer"
        >
          Back
        </button>
      </div>
    </div>
  );
}

function KeypadButton({
  children, onClick, disabled, muted,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  muted?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`min-h-[64px] rounded-xl border text-xl font-semibold transition disabled:opacity-40 cursor-pointer ${
        muted
          ? 'bg-slate-50 border-slate-200 text-slate-600 text-base'
          : 'bg-white border-slate-300 text-slate-900 hover:bg-slate-50 active:bg-slate-100'
      }`}
    >
      {children}
    </button>
  );
}
