import { useCallback, useEffect, useState } from 'react';
import { tenantFetch } from '../lib/apiClient';

// Which parts of the system this restaurant uses.
//
// Replaces scripts/enable-pos.ts. Reads the whole config, changes the handful of
// switches, and posts it back — /api/admin/save-config validates the result, so
// this screen cannot store a config that would take the kiosk offline.

interface Config {
  slug: string;
  restaurantName: string;
  adapter:  { type: string };
  features: { pos: boolean; reservations: boolean; deliveryOrders: boolean; tableNumbers: boolean;
              transcriptScreen: boolean; loyaltyPoints: boolean };
  channels?: {
    qr?:    { enabled: boolean; requirePin: boolean; orderMode: string; waiterCooldown: number };
    phone?: { enabled: boolean; didNumber?: string; transferTo?: string; maxCallSeconds?: number };
    whatsapp?: { enabled: boolean; wabaPhoneNumberId?: string };
  };
  businessRules: { pos: { serviceChargeRate: number } };
}

export default function SetupModules() {
  const [config, setConfig] = useState<Config | null>(null);
  const [draft,  setDraft]  = useState<Config | null>(null);
  const [error,  setError]  = useState<string | null>(null);
  const [ok,     setOk]     = useState(false);
  const [busy,   setBusy]   = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await tenantFetch('/api/admin/my-config');
      if (!res.ok) throw new Error(`config ${res.status}`);
      // Top level, not { config } — see the note in PosTerminal.
      const body = await res.json() as Config;
      setConfig(body);
      setDraft(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!ok) return;
    const id = setTimeout(() => setOk(false), 3000);
    return () => clearTimeout(id);
  }, [ok]);

  async function save() {
    if (!draft) return;
    setBusy(true); setError(null);
    try {
      // The WHOLE config goes back, not a patch: save-config re-validates it as
      // one document, which is what stops a half-written change being stored.
      const res  = await tenantFetch('/api/admin/save-config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(draft),
      });
      const body = await res.json() as { error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not save'); return; }
      setOk(true);
      await load();
    } finally { setBusy(false); }
  }

  if (!draft) {
    return <p className="text-slate-500">{error ?? 'Loading…'}</p>;
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  const set = (fn: (d: Config) => Config) => setDraft(d => (d ? fn(structuredClone(d)) : d));

  const qr    = draft.channels?.qr;
  const phone = draft.channels?.phone;

  return (
    <div className="space-y-4 max-w-2xl">
      {error && (
        <div className="px-4 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">{error}</div>
      )}
      {ok && (
        <div className="px-4 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">
          Saved. Staff should sign out and back in to pick up the change.
        </div>
      )}

      <Card
        title="Till"
        desc="The cashier screen: take orders and payments, run the cash drawer, see the kitchen."
        on={draft.features.pos}
        onToggle={v => set(d => {
          d.features.pos = v;
          // The Till always keeps its own orders in our database. Turning it on
          // while a different ordering system is selected above would mean two
          // separate order lists that never agree with each other — so turning
          // the Till on also switches ordering to match. Turning it off leaves
          // ordering as-is; nothing already sold is affected either way.
          if (v) d.adapter.type = 'pos';
          return d;
        })}
      >
        {draft.adapter.type !== 'pos' && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Your menu currently comes from {draft.adapter.type === 'managed' ? 'Savour Managed' : 'a connected system'}.
            Turning the Till on switches to the built-in menu — add your dishes in
            the admin panel's Menu tab if you have not already.
          </p>
        )}
        <Row label="Service charge added to every order (%)">
          <input
            value={String(Math.round(draft.businessRules.pos.serviceChargeRate * 1000) / 10)}
            onChange={e => set(d => {
              const pct = Math.min(100, Math.max(0, Number(e.target.value) || 0));
              d.businessRules.pos.serviceChargeRate = pct / 100;
              return d;
            })}
            inputMode="decimal"
            className="w-24 min-h-[44px] px-3 rounded-lg border border-slate-300 tabular-nums"
          />
        </Row>
      </Card>

      <Card
        title="Table ordering (QR codes)"
        desc="Diners scan a code on the table and order by voice from their own phone."
        on={qr?.enabled === true}
        onToggle={v => set(d => {
          d.channels = d.channels ?? {};
          d.channels.qr = {
            enabled: v,
            requirePin:     qr?.requirePin ?? true,
            orderMode:      qr?.orderMode ?? 'direct',
            waiterCooldown: qr?.waiterCooldown ?? 60,
          };
          return d;
        })}
      >
        <Check
          label="Require the PIN printed on the table"
          hint="Strongly recommended. Without it, anyone who photographs the code can order to that table from anywhere."
          checked={qr?.requirePin !== false}
          onChange={v => set(d => { d.channels!.qr!.requirePin = v; return d; })}
        />
        <Row label="Seconds before a table can call a waiter again">
          <input
            value={String(qr?.waiterCooldown ?? 60)}
            onChange={e => set(d => {
              d.channels!.qr!.waiterCooldown =
                Math.min(600, Math.max(0, Number(e.target.value) || 0));
              return d;
            })}
            inputMode="numeric"
            className="w-24 min-h-[44px] px-3 rounded-lg border border-slate-300 tabular-nums"
          />
        </Row>
        {qr?.enabled && (
          <p className="text-xs text-slate-500">
            Next: go to <strong>Tables</strong> to create tables and print their codes.
          </p>
        )}
      </Card>

      <Card
        title="Bookings"
        desc="Take reservations and hold walk-ins on a waitlist."
        on={draft.features.reservations}
        onToggle={v => set(d => { d.features.reservations = v; return d; })}
      />

      <Card
        title="Phone ordering"
        desc="The agent answers your phone line and takes delivery, pick-up and take-away orders."
        on={phone?.enabled === true}
        onToggle={v => set(d => {
          d.channels = d.channels ?? {};
          d.channels.phone = {
            enabled: v,
            didNumber:      phone?.didNumber ?? '',
            transferTo:     phone?.transferTo ?? '',
            maxCallSeconds: phone?.maxCallSeconds ?? 600,
          };
          return d;
        })}
      >
        {/* Said here rather than discovered later: this one needs hardware. */}
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Needs a phone line connected by your provider before it will do anything.
        </p>
        <Row label="Your phone number (the one customers dial)">
          <input
            value={phone?.didNumber ?? ''}
            onChange={e => set(d => { d.channels!.phone!.didNumber = e.target.value; return d; })}
            placeholder="+92 300 1234567"
            className="flex-1 min-w-[10rem] min-h-[44px] px-3 rounded-lg border border-slate-300"
          />
        </Row>
        <Row label="Put callers through to this number if they ask for a person">
          <input
            value={phone?.transferTo ?? ''}
            onChange={e => set(d => { d.channels!.phone!.transferTo = e.target.value; return d; })}
            placeholder="leave blank for none"
            className="flex-1 min-w-[10rem] min-h-[44px] px-3 rounded-lg border border-slate-300"
          />
        </Row>
      </Card>

      <div className="sticky bottom-0 bg-slate-100 py-3">
        <button
          onClick={() => void save()}
          disabled={busy || !dirty}
          className="w-full min-h-[52px] rounded-xl bg-slate-900 text-white font-bold disabled:opacity-40 cursor-pointer"
        >
          {busy ? 'Saving…' : dirty ? 'Save changes' : 'No changes'}
        </button>
      </div>
    </div>
  );
}

// ── bits ─────────────────────────────────────────────────────────────────────

function Card({
  title, desc, on, onToggle, children,
}: {
  title: string; desc: string; on: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <section className={`rounded-xl border p-4 ${on ? 'bg-white border-slate-300' : 'bg-slate-50 border-slate-200'}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-bold">{title}</h3>
          <p className="text-xs text-slate-500 mt-0.5">{desc}</p>
        </div>
        <Switch on={on} onChange={onToggle} label={title} />
      </div>
      {on && children && <div className="mt-4 space-y-3">{children}</div>}
    </section>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`shrink-0 w-14 h-8 rounded-full transition relative cursor-pointer ${
        on ? 'bg-emerald-500' : 'bg-slate-300'
      }`}
    >
      <span
        className={`absolute top-1 w-6 h-6 rounded-full bg-white transition-all ${
          on ? 'left-7' : 'left-1'
        }`}
      />
    </button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-sm text-slate-700 flex-1 min-w-[12rem]">{label}</span>
      {children}
    </div>
  );
}

function Check({ label, hint, checked, onChange }: {
  label: string; hint: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2.5 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 w-5 h-5 shrink-0 cursor-pointer"
      />
      <span className="min-w-0">
        <span className="text-sm font-medium block">{label}</span>
        <span className="text-[11px] text-slate-500">{hint}</span>
      </span>
    </label>
  );
}
