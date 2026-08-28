import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tenantFetch, getCurrentRole } from '../lib/apiClient';
import { useEventStream, type StreamEvent, type StreamStatus } from '../lib/useEventStream';
import type { PosPermissions } from '../lib/staffRepo';
import type { WireOrder } from '../lib/types';
import PinGate, { type Operator } from './PinGate';
import OrderEntry from './OrderEntry';
import PaymentDrawer from './PaymentDrawer';
import ShiftReport from './ShiftReport';
import ServiceAlerts, { type ServiceRequest } from './ServiceAlerts';
import KitchenDisplay from './KitchenDisplay';
import Reservations from './Reservations';
import Reports from './Reports';
import SetupPanel from './SetupPanel';

// The cashier terminal.
//
// Four tabs over one live data set: ring an order in, see the floor, work the
// active order list, and read the drawer. Everything is driven by the SSE
// stream (src/lib/useEventStream.ts) rather than polling, so an order placed on
// any channel — kiosk, phone, WhatsApp, QR — lands here within a second.
//
// State is patched in place from events where that is safe, and refetched when
// it is not: the event says what happened, the server says what is true.
//
// Everything here is touch-first — 44px minimum hit targets, no hover-only
// affordances — because the primary device is a fixed screen a person prods
// with a thumb while holding a card machine.

export interface VenueTable {
  id: string;
  area: string;
  label: string;
  seats: number;
  status: 'available' | 'occupied' | 'reserved' | 'disabled';
}

export interface ShiftState {
  shift: { id: string; opened_at: string; opening_float: string | number } | null;
  expectedCash?: number;
  openOrders?: number;
}

type Tab = 'new' | 'floor' | 'orders' | 'kitchen' | 'bookings' | 'shift' | 'reports' | 'setup';

const ACTIVE_STATUSES = ['pending', 'confirmed', 'preparing', 'ready'];

// Tab captions. 'new' and 'setup' read badly as bare words next to the others.
const TAB_LABEL: Partial<Record<Tab, string>> = {
  new:   'New order',
  setup: 'Setup',
};

function tabsFor(hasReservations: boolean, isAdmin: boolean): Tab[] {
  const base: Tab[] = ['new', 'floor', 'orders', 'kitchen'];
  if (hasReservations) base.push('bookings');
  base.push('shift', 'reports');
  // Setup is admin-only. A cashier must not be able to switch the till off
  // mid-service, or grant themselves the void permission.
  if (isAdmin) base.push('setup');
  return base;
}

export default function PosTerminal({ onExit }: { onExit: () => void }) {
  const [operator, setOperator] = useState<Operator | null>(null);
  const [tab,      setTab]      = useState<Tab>('new');
  // Which order the payment drawer is open on, if any.
  const [payingFor, setPayingFor] = useState<string | null>(null);
  const [currency,  setCurrency]  = useState('');
  const [alerts,    setAlerts]    = useState<ServiceRequest[]>([]);
  // Muting is per terminal and per session: an expo screen in a noisy kitchen
  // wants silence, the front counter does not.
  const [muted,     setMuted]     = useState(false);
  // Bookings is a separately-sold module; the tab only exists when the tenant
  // has it. requireFeature('reservations') would 403 the fetch anyway, but an
  // empty tab is a worse answer than no tab.
  const [hasReservations, setHasReservations] = useState(false);
  // From the JWT, not from whether an admin endpoint answered: my-config only
  // requires a login, so a cashier reaching it would otherwise be shown Setup.
  const isAdmin = ['tenant_admin', 'super_admin'].includes(getCurrentRole() ?? '');

  const [tables, setTables] = useState<VenueTable[]>([]);
  const [orders, setOrders] = useState<WireOrder[]>([]);
  const [shift,  setShift]  = useState<ShiftState>({ shift: null });
  const [error,  setError]  = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // ── Data loading ───────────────────────────────────────────────────────────
  // One function for the full picture. It is the resync path as well as the
  // initial load, so a stream gap and a cold start take the identical code
  // path — a resync that differs from a first load is a resync that rots.
  const refetch = useCallback(async () => {
    try {
      const [tRes, oRes, sRes, cRes, aRes] = await Promise.all([
        tenantFetch('/api/pos/tables'),
        tenantFetch('/api/orders/active'),
        tenantFetch('/api/pos/shifts/current'),
        tenantFetch('/api/admin/my-config'),
        tenantFetch('/api/pos/service-requests'),
      ]);

      // Currency is presentation only, so a failure here must not stop the
      // floor loading — an unlabelled number beats a blank screen.
      if (cRes.ok) {
        // /api/admin/my-config returns the config at the TOP level, not wrapped
        // in { config }. Reading cfg.config here silently yielded undefined and
        // left every price on the till unlabelled.
        const cfg = await cRes.json() as {
          businessRules?: { currencySymbol?: string };
          features?: { reservations?: boolean };
        };
        setCurrency(cfg.businessRules?.currencySymbol ?? '');
        setHasReservations(cfg.features?.reservations === true);
      }

      if (aRes.ok) setAlerts(await aRes.json() as ServiceRequest[]);

      if (!tRes.ok || !oRes.ok || !sRes.ok) {
        throw new Error(`tables ${tRes.status} · orders ${oRes.status} · shift ${sRes.status}`);
      }

      setTables(await tRes.json() as VenueTable[]);
      setOrders(await oRes.json() as WireOrder[]);
      setShift(await sRes.json() as ShiftState);
      setError(null);
    } catch (err) {
      // Surfaced, never swallowed: a till showing a stale floor with no warning
      // is worse than one that says it has lost touch with the server.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { if (operator) void refetch(); }, [operator, refetch]);

  // ── Live updates ───────────────────────────────────────────────────────────
  // Events patch state in place so the common case costs no network at all.
  // Anything that would need a wider read (a brand-new order's full line items)
  // triggers a targeted refetch rather than being reconstructed from the event
  // payload — the event says what happened, the server says what is true.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRefetch = useCallback(() => {
    // Coalesce bursts: a six-cover table paying by seat fires six events in a
    // second, and six full reloads would make the terminal stutter.
    clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => { void refetch(); }, 250);
  }, [refetch]);

  const onEvent = useCallback((e: StreamEvent) => {
    switch (e.type) {
      case 'table.status': {
        const { tableId, status } = e.data as { tableId: string; status: VenueTable['status'] };
        setTables(prev => prev.map(t => (t.id === tableId ? { ...t, status } : t)));
        break;
      }
      case 'order.status': {
        const { orderId, status } = e.data as { orderId: string; status: string };
        setOrders(prev => ACTIVE_STATUSES.includes(status)
          ? prev.map(o => (o.id === orderId ? { ...o, status } : o))
          : prev.filter(o => o.id !== orderId));   // left the active set
        break;
      }
      case 'order.voided': {
        const { orderId } = e.data as { orderId: string };
        setOrders(prev => prev.filter(o => o.id !== orderId));
        break;
      }
      case 'service_request.created': {
        // Prepend rather than refetch: the alert has to appear the instant the
        // guest presses the button, and the event already carries the label.
        const d = e.data as unknown as ServiceRequest & { requestId: string };
        setAlerts(prev => prev.some(a => a.id === d.requestId) ? prev : [...prev, {
          id: d.requestId, tableId: d.tableId, tableLabel: d.tableLabel,
          area: d.area, type: d.type, note: d.note, status: 'open',
          createdAt: d.createdAt,
        }]);
        break;
      }
      case 'service_request.cleared': {
        const { requestId, status } = e.data as { requestId: string; status: string };
        setAlerts(prev => status === 'resolved'
          ? prev.filter(a => a.id !== requestId)
          : prev.map(a => (a.id === requestId ? { ...a, status } : a)));
        break;
      }
      case 'order.created':
      case 'order.paid':
      case 'order.transferred':
        scheduleRefetch();
        break;
      case 'shift.opened':
      case 'shift.closed':
        scheduleRefetch();
        break;
    }
  }, [scheduleRefetch]);

  const streamStatus = useEventStream(onEvent, {
    enabled:  Boolean(operator),
    onResync: refetch,
  });

  useEffect(() => () => clearTimeout(refetchTimer.current), []);

  // ── Derived ────────────────────────────────────────────────────────────────

  const ordersByTable = useMemo(() => {
    const m = new Map<string, WireOrder[]>();
    for (const o of orders) {
      const key = (o as WireOrder & { table_id?: string }).table_id;
      if (!key) continue;
      const list = m.get(key) ?? [];
      list.push(o);
      m.set(key, list);
    }
    return m;
  }, [orders]);

  const areas = useMemo(() => {
    const grouped = new Map<string, VenueTable[]>();
    for (const t of tables) {
      const list = grouped.get(t.area) ?? [];
      list.push(t);
      grouped.set(t.area, list);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tables]);

  if (!operator) {
    return <PinGate onIdentified={setOperator} onCancel={onExit} />;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-slate-100">
      <TerminalHeader
        operator={operator}
        streamStatus={streamStatus}
        shift={shift}
        onSwitchOperator={() => setOperator(null)}
        onExit={onExit}
      />

      <ServiceAlerts
        requests={alerts}
        staffId={operator.staffId}
        muted={muted}
        onToggleMute={() => setMuted(m => !m)}
        onChanged={refetch}
      />

      <nav className="shrink-0 flex gap-1 px-3 bg-white border-b border-slate-200">
        {tabsFor(hasReservations, isAdmin).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`min-h-[44px] px-5 text-sm font-semibold capitalize border-b-2 transition cursor-pointer ${
              tab === t
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            {TAB_LABEL[t] ?? t}
            {t === 'orders' && orders.length > 0 && (
              <span className="ml-2 text-xs bg-slate-900 text-white rounded-full px-2 py-0.5">
                {orders.length}
              </span>
            )}
          </button>
        ))}
      </nav>

      {error && (
        <div className="shrink-0 px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-800 flex items-center justify-between gap-4">
          <span>Could not reach the server — this screen may be out of date. ({error})</span>
          <button onClick={() => void refetch()} className="shrink-0 min-h-[36px] px-3 rounded-lg border border-red-300 font-semibold hover:bg-red-100 cursor-pointer">
            Retry
          </button>
        </div>
      )}

      <main className="flex-1 overflow-auto p-4">
        {!loaded && <p className="text-slate-500">Loading…</p>}

        {tab === 'new' && (
          <OrderEntry
            operator={operator}
            currency={currency}
            onPlaced={id => { setPayingFor(id); void refetch(); }}
          />
        )}
        {loaded && tab === 'floor' && (
          <FloorBoard areas={areas} ordersByTable={ordersByTable} onPay={setPayingFor} />
        )}
        {loaded && tab === 'orders' && <OrderList orders={orders} onPay={setPayingFor} />}
        {tab === 'kitchen'  && <KitchenDisplay staffId={operator.staffId} />}
        {tab === 'bookings' && <Reservations />}
        {tab === 'reports'  && <Reports currency={currency} />}
        {tab === 'setup'    && <SetupPanel />}
        {loaded && tab === 'shift' && (
          <ShiftPanel shift={shift} operator={operator} currency={currency} onChanged={refetch} />
        )}
      </main>

      {payingFor && (
        <PaymentDrawer
          orderId={payingFor}
          operator={operator}
          currency={currency}
          onClose={() => { setPayingFor(null); void refetch(); }}
          onSettled={() => { setPayingFor(null); void refetch(); }}
        />
      )}
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────

function TerminalHeader({
  operator, streamStatus, shift, onSwitchOperator, onExit,
}: {
  operator: Operator;
  streamStatus: StreamStatus;
  shift: ShiftState;
  onSwitchOperator: () => void;
  onExit: () => void;
}) {
  return (
    <header className="shrink-0 flex items-center justify-between gap-4 px-4 py-2.5 bg-white border-b border-slate-200">
      <div className="flex items-center gap-3 min-w-0">
        <span className="font-bold text-slate-900">Till</span>
        <StreamBadge status={streamStatus} />
        {shift.shift
          ? <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-2 py-1">Shift open</span>
          : <span className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">No shift open</span>}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-slate-500 hidden sm:inline truncate max-w-[16rem]">{operator.email}</span>
        <button onClick={onSwitchOperator} className="min-h-[44px] px-3 text-sm font-semibold rounded-lg border border-slate-300 hover:bg-slate-50 cursor-pointer">
          Switch user
        </button>
        <button onClick={onExit} className="min-h-[44px] px-3 text-sm font-semibold rounded-lg border border-slate-300 hover:bg-slate-50 cursor-pointer">
          Exit
        </button>
      </div>
    </header>
  );
}

// The connection state is shown permanently rather than only on failure. Staff
// need to be able to tell "no new orders" from "not receiving orders" at a
// glance, and only one of those is normal.
function StreamBadge({ status }: { status: StreamStatus }) {
  const map: Record<StreamStatus, { dot: string; label: string; cls: string }> = {
    open:         { dot: 'bg-emerald-500', label: 'Live',         cls: 'text-emerald-700' },
    connecting:   { dot: 'bg-amber-400',   label: 'Connecting…',  cls: 'text-amber-700' },
    reconnecting: { dot: 'bg-amber-400',   label: 'Reconnecting…', cls: 'text-amber-700' },
    closed:       { dot: 'bg-slate-400',   label: 'Offline',      cls: 'text-slate-500' },
  };
  const s = map[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${s.cls}`}>
      <span className={`w-2 h-2 rounded-full ${s.dot} ${status === 'open' ? '' : 'animate-pulse'}`} />
      {s.label}
    </span>
  );
}

// ── Floor ────────────────────────────────────────────────────────────────────

const TABLE_STYLE: Record<VenueTable['status'], string> = {
  available: 'bg-white border-slate-300 text-slate-700',
  occupied:  'bg-slate-900 border-slate-900 text-white',
  reserved:  'bg-amber-50 border-amber-300 text-amber-900',
  disabled:  'bg-slate-100 border-slate-200 text-slate-400',
};

function FloorBoard({
  areas, ordersByTable, onPay,
}: {
  areas: [string, VenueTable[]][];
  ordersByTable: Map<string, WireOrder[]>;
  onPay: (orderId: string) => void;
}) {
  if (areas.length === 0) {
    return (
      <EmptyState
        title="No tables yet"
        body="Add tables in the admin panel to see the floor here. Each table can then carry its own open tab."
      />
    );
  }

  return (
    <div className="space-y-6">
      {areas.map(([area, list]) => (
        <section key={area}>
          <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">{area}</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
            {list.map(t => {
              const tabs  = ordersByTable.get(t.id) ?? [];
              const total = tabs.reduce((s, o) => s + Number(o.total_amount ?? 0), 0);
              return (
                <button
                  key={t.id}
                  onClick={() => { if (tabs[0]) onPay(tabs[0].id); }}
                  disabled={tabs.length === 0}
                  className={`text-left rounded-xl border-2 p-3 min-h-[7rem] flex flex-col justify-between ${TABLE_STYLE[t.status]} ${tabs.length > 0 ? 'cursor-pointer' : 'cursor-default'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-bold text-lg leading-none">{t.label}</span>
                    <span className="text-[10px] opacity-70">{t.seats} seats</span>
                  </div>
                  {tabs.length > 0 ? (
                    <div className="text-xs">
                      <div className="font-semibold">{tabs.length} order{tabs.length > 1 ? 's' : ''}</div>
                      <div className="opacity-80">{total.toFixed(2)}</div>
                    </div>
                  ) : (
                    <span className="text-xs opacity-60 capitalize">{t.status}</span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// ── Orders ───────────────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<string, string> = {
  pos: 'Till', kiosk: 'Kiosk', phone: 'Phone', whatsapp: 'WhatsApp', qr: 'QR', web: 'Web',
};

function OrderList({ orders, onPay }: { orders: WireOrder[]; onPay: (id: string) => void }) {
  if (orders.length === 0) {
    return <EmptyState title="No active orders" body="New orders appear here the moment they are rung in — on any channel." />;
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3">
      {orders.map(o => {
        const src = (o as WireOrder & { source?: string }).source;
        return (
          <article key={o.id} className="bg-white rounded-xl border border-slate-200 p-3">
            <header className="flex items-center justify-between gap-2 mb-2">
              <span className="font-bold">#{o.order_number ?? '—'}</span>
              <span className="text-[10px] font-semibold uppercase tracking-wider bg-slate-100 rounded-md px-2 py-1">
                {o.status}
              </span>
            </header>
            <div className="text-xs text-slate-500 mb-2 flex flex-wrap gap-x-3">
              <span>{o.order_type}</span>
              {src && <span>{SOURCE_LABEL[src] ?? src}</span>}
              <span>{o.customer_name}</span>
            </div>
            <ul className="text-sm space-y-0.5 mb-2">
              {o.items?.map((i, idx) => (
                <li key={idx} className="flex justify-between gap-2">
                  <span className="truncate">{i.quantity}× {i.dish_name}</span>
                  <span className="tabular-nums shrink-0">{Number(i.item_total ?? 0).toFixed(2)}</span>
                </li>
              ))}
            </ul>
            <footer className="flex justify-between font-bold border-t border-slate-100 pt-2 mb-2">
              <span>Total</span>
              <span className="tabular-nums">{Number(o.total_amount ?? 0).toFixed(2)}</span>
            </footer>
            <button
              onClick={() => onPay(o.id)}
              className="w-full min-h-[40px] rounded-lg bg-slate-900 text-white text-sm font-semibold cursor-pointer"
            >
              Take payment
            </button>
          </article>
        );
      })}
    </div>
  );
}

// ── Shift ────────────────────────────────────────────────────────────────────

function ShiftPanel({
  shift, operator, currency, onChanged,
}: {
  shift: ShiftState;
  operator: Operator;
  currency: string;
  onChanged: () => Promise<void>;
}) {
  const [float, setFloat]   = useState('0');
  const [busy,  setBusy]    = useState(false);
  const [err,   setErr]     = useState<string | null>(null);

  async function openShift() {
    setBusy(true); setErr(null);
    try {
      const res = await tenantFetch('/api/pos/shifts/open', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ openingFloat: Number(float) || 0 }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!shift.shift) {
    return (
      <div className="max-w-sm bg-white rounded-xl border border-slate-200 p-4">
        <h2 className="font-bold mb-1">Open a shift</h2>
        <p className="text-sm text-slate-500 mb-3">
          Sales are recorded against a shift so the drawer can be reconciled at close.
        </p>
        <label className="block text-xs font-semibold text-slate-600 mb-1">Opening float</label>
        <input
          value={float}
          onChange={e => setFloat(e.target.value)}
          inputMode="decimal"
          className="w-full min-h-[44px] px-3 rounded-lg border border-slate-300 mb-3 tabular-nums"
        />
        {err && <p className="text-sm text-red-700 mb-2">{err}</p>}
        <button
          onClick={() => void openShift()}
          disabled={busy}
          className="w-full min-h-[44px] rounded-lg bg-slate-900 text-white font-semibold disabled:opacity-50 cursor-pointer"
        >
          {busy ? 'Opening…' : 'Open shift'}
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-sm bg-white rounded-xl border border-slate-200 p-4 space-y-2 text-sm">
      <h2 className="font-bold">Shift open</h2>
      <Row label="Opened"        value={new Date(shift.shift.opened_at).toLocaleString()} />
      <Row label="Opening float" value={Number(shift.shift.opening_float).toFixed(2)} />
      {shift.expectedCash !== undefined && <Row label="Expected cash" value={shift.expectedCash.toFixed(2)} />}
      {shift.openOrders !== undefined && <Row label="Open orders" value={String(shift.openOrders)} />}
      <div className="pt-2 border-t border-slate-100">
        <ShiftReport
          shiftId={shift.shift.id}
          currency={currency}
          canClose={operator.permissions.can_close_shift}
          onClosed={onChanged}
        />
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-slate-500">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="max-w-md mx-auto mt-12 text-center">
      <h2 className="font-bold text-slate-800 mb-1">{title}</h2>
      <p className="text-sm text-slate-500">{body}</p>
    </div>
  );
}

export type { PosPermissions };
