import { useCallback, useEffect, useState } from 'react';
import GuestVoice from './GuestVoice';

// The diner's app. Reached by scanning the QR on the table:
//   /t/<tenant-slug>/<qr-token>
//
// Scope is deliberately narrow. A guest can see the menu, build a basket, send
// it to the kitchen, watch it cook and call a waiter. That is all. There is no
// route from here into the till, the order book or anyone else's table — see
// middleware/guest.ts and testing/test-guest-isolation.ts.
//
// Session state is held in sessionStorage, not localStorage: a table session
// should not survive on a phone for days after the meal.

const TOKEN_KEY = 'echo_guest_token';
const CTX_KEY   = 'echo_guest_ctx';

interface Ctx {
  table:      { label: string; area: string };
  restaurant: { name: string; currencySymbol: string; primaryColor: string; logoUrl: string };
}

interface CartItem {
  cart_item_id: string;
  dish_name:    string;
  summary?:     string | null;
  quantity:     number;
  unit_price:   number | string;
}
interface Totals { subtotal: number; discount: number; serviceCharge: number; tax: number; total: number }

interface MenuDish {
  id: string; dish_id: number; name: string; description: string;
  price: number; available: boolean;
}
interface MenuCategory { id: string; name: string; items: MenuDish[] }

interface TrackedOrder {
  orderId: string; orderNumber: number | null; status: string; placedAt: string; total: number;
}

type Tab = 'menu' | 'basket' | 'orders';

export default function GuestApp() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));
  const [ctx,   setCtx]   = useState<Ctx | null>(() => {
    try { const raw = sessionStorage.getItem(CTX_KEY); return raw ? JSON.parse(raw) as Ctx : null; }
    catch { return null; }
  });

  if (!token || !ctx) {
    return <ScanGate onJoined={(t, c) => {
      sessionStorage.setItem(TOKEN_KEY, t);
      sessionStorage.setItem(CTX_KEY, JSON.stringify(c));
      setToken(t); setCtx(c);
    }} />;
  }

  return <Ordering token={token} ctx={ctx} onExpired={() => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(CTX_KEY);
    setToken(null); setCtx(null);
  }} />;
}

// ── Joining the table ────────────────────────────────────────────────────────

function ScanGate({ onJoined }: { onJoined: (token: string, ctx: Ctx) => void }) {
  const qrToken = readTokenFromUrl();
  const [pin,   setPin]   = useState('');
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = useCallback(async (enteredPin: string) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/guest/session', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ qrToken, pin: enteredPin }),
      });
      const body = await res.json() as { error?: string; token?: string } & Ctx;
      if (!res.ok || !body.token) { setError(body.error ?? 'Could not start'); setPin(''); return; }
      onJoined(body.token, { table: body.table, restaurant: body.restaurant });
    } catch {
      setError('No connection. Check the restaurant WiFi and try again.');
    } finally {
      setBusy(false);
    }
  }, [qrToken, onJoined]);

  useEffect(() => {
    if (pin.length === 4 && !busy) void join(pin);
  }, [pin, busy, join]);

  if (!qrToken) {
    return (
      <Centre>
        <h1 className="text-lg font-bold mb-2">Scan the code on your table</h1>
        <p className="text-sm text-slate-500">
          This page is opened by scanning the QR code printed on your table.
        </p>
      </Centre>
    );
  }

  return (
    <Centre>
      <h1 className="text-lg font-bold mb-1">Enter the PIN on your table</h1>
      <p className="text-sm text-slate-500 mb-6">
        It is printed next to the QR code you just scanned.
      </p>

      <div className="flex justify-center gap-3 mb-6">
        {Array.from({ length: 4 }, (_, i) => (
          <span
            key={i}
            className={`w-4 h-4 rounded-full border-2 ${
              i < pin.length ? 'bg-slate-900 border-slate-900' : 'border-slate-300'
            }`}
          />
        ))}
      </div>

      {error && <p className="text-sm text-red-700 mb-4">{error}</p>}

      <div className="grid grid-cols-3 gap-2 max-w-[15rem] mx-auto">
        {['1','2','3','4','5','6','7','8','9'].map(d => (
          <Key key={d} onClick={() => setPin(p => (p.length < 4 ? p + d : p))} disabled={busy}>{d}</Key>
        ))}
        <Key onClick={() => setPin('')} disabled={busy} muted>Clear</Key>
        <Key onClick={() => setPin(p => (p.length < 4 ? p + '0' : p))} disabled={busy}>0</Key>
        <Key onClick={() => setPin(p => p.slice(0, -1))} disabled={busy} muted>←</Key>
      </div>
    </Centre>
  );
}

// ── Ordering ─────────────────────────────────────────────────────────────────

function Ordering({ token, ctx, onExpired }: { token: string; ctx: Ctx; onExpired: () => void }) {
  const [tab,    setTab]    = useState<Tab>('menu');
  const [menu,   setMenu]   = useState<MenuCategory[]>([]);
  const [cat,    setCat]    = useState<string | null>(null);
  const [cart,   setCart]   = useState<CartItem[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [orders, setOrders] = useState<TrackedOrder[]>([]);
  const [toast,  setToast]  = useState<string | null>(null);
  const [error,  setError]  = useState<string | null>(null);
  const [waiterCooldown, setWaiterCooldown] = useState(0);

  const cur = ctx.restaurant.currencySymbol;

  const api = useCallback(async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`/api/guest${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
    // A three-hour session can lapse mid-meal. Drop straight back to the PIN
    // screen rather than leaving the diner tapping a dead button.
    if (res.status === 401) { onExpired(); throw new Error('session expired'); }
    return res;
  }, [token, onExpired]);

  const loadCart = useCallback(async () => {
    const res  = await api('/cart');
    const body = await res.json() as { items: CartItem[]; totals: Totals };
    setCart(body.items);
    setTotals(body.totals);
  }, [api]);

  const loadOrders = useCallback(async () => {
    const res = await api('/orders');
    setOrders(await res.json() as TrackedOrder[]);
  }, [api]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api('/menu');
        const data = await res.json() as MenuCategory[];
        setMenu(data);
        setCat(data[0]?.id ?? null);
        await loadCart();
        await loadOrders();
      } catch (err) {
        if ((err as Error).message !== 'session expired') {
          setError('Could not load the menu. Please ask a member of staff.');
        }
      }
    })();
  }, [api, loadCart, loadOrders]);

  // Poll the guest's own orders while any are still cooking. A diner has no
  // event stream — SSE per phone would be a connection per cover — and the
  // stakes are "is my food coming", so a slow poll is the right trade.
  useEffect(() => {
    const cooking = orders.some(o => !['delivered', 'cancelled', 'voided'].includes(o.status));
    if (!cooking) return;
    const id = setInterval(() => { void loadOrders().catch(() => undefined); }, 20_000);
    return () => clearInterval(id);
  }, [orders, loadOrders]);

  useEffect(() => {
    if (waiterCooldown <= 0) return;
    const id = setTimeout(() => setWaiterCooldown(s => s - 1), 1000);
    return () => clearTimeout(id);
  }, [waiterCooldown]);

  async function add(dish: MenuDish) {
    try {
      const res  = await api('/cart/item', {
        method: 'POST', body: JSON.stringify({ dishQuery: dish.name, quantity: 1 }),
      });
      const body = await res.json() as { status: string; ai_instruction?: string };
      // requires_input means the dish needs a choice (size, piece) that this
      // simple tap flow cannot express. Say so plainly instead of silently
      // adding a half-specified item to the kitchen's ticket.
      if (body.status !== 'ok') {
        setToast(body.ai_instruction ?? 'That item needs a choice — please ask your waiter.');
        return;
      }
      await loadCart();
      setToast(`${dish.name} added`);
    } catch { /* session expiry already handled */ }
  }

  async function remove(cartItemId: string) {
    try {
      await api(`/cart/item/${cartItemId}`, { method: 'DELETE' });
      await loadCart();
    } catch { /* handled */ }
  }

  async function send() {
    try {
      const res  = await api('/order', { method: 'POST', body: JSON.stringify({}) });
      const body = await res.json() as { error?: string; orderNumber?: number };
      if (!res.ok) { setToast(body.error ?? 'Could not send your order'); return; }
      await loadCart();
      await loadOrders();
      setTab('orders');
      setToast(`Order #${body.orderNumber} sent to the kitchen`);
    } catch { /* handled */ }
  }

  async function callWaiter() {
    try {
      const res  = await api('/service-request', {
        method: 'POST', body: JSON.stringify({ type: 'call_waiter' }),
      });
      const body = await res.json() as { error?: string; cooldown?: number; retryAfter?: number };
      if (res.status === 429) {
        setToast(body.error ?? 'Someone is already coming');
        setWaiterCooldown(body.retryAfter ?? 30);
        return;
      }
      if (!res.ok) { setToast(body.error ?? 'Could not call a waiter'); return; }
      setWaiterCooldown(body.cooldown ?? 60);
      setToast('A waiter is on the way');
    } catch { /* handled */ }
  }

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(id);
  }, [toast]);

  const cartCount = cart.reduce((s, i) => s + i.quantity, 0);
  const visible   = menu.find(c => c.id === cat)?.items ?? [];

  return (
    <div className="flex flex-col h-full bg-slate-50">
      <header className="shrink-0 px-4 py-3 bg-white border-b border-slate-200">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-bold truncate">{ctx.restaurant.name}</h1>
            <p className="text-xs text-slate-500">
              {ctx.table.area} · Table {ctx.table.label}
            </p>
          </div>
          <button
            onClick={() => void callWaiter()}
            disabled={waiterCooldown > 0}
            className="shrink-0 min-h-[44px] px-4 rounded-xl bg-amber-500 text-white text-sm font-bold disabled:opacity-50 cursor-pointer"
          >
            {waiterCooldown > 0 ? `Called (${waiterCooldown}s)` : 'Call waiter'}
          </button>
        </div>
      </header>

      {error && (
        <div className="shrink-0 px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-800">
          {error}
        </div>
      )}

      <main className="flex-1 overflow-auto">
        {tab === 'menu' && (
          <>
            <div className="sticky top-0 z-10 bg-slate-50 flex gap-2 overflow-x-auto px-4 py-2">
              {menu.map(c => (
                <button
                  key={c.id}
                  onClick={() => setCat(c.id)}
                  className={`shrink-0 min-h-[40px] px-4 rounded-full text-sm font-semibold border transition cursor-pointer ${
                    cat === c.id ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-300'
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
            <p className="px-4 pb-2 text-xs text-slate-500">
              Hold the button below and just say what you want — or tap to add.
            </p>
            <ul className="px-4 pb-4 divide-y divide-slate-200">
              {visible.map(d => (
                <li key={d.id} className="py-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium leading-tight">{d.name}</p>
                    {d.description && (
                      <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{d.description}</p>
                    )}
                    <p className="text-sm mt-1 tabular-nums">{cur} {d.price.toFixed(2)}</p>
                  </div>
                  <button
                    onClick={() => void add(d)}
                    disabled={!d.available}
                    className="shrink-0 min-h-[44px] px-4 rounded-xl bg-slate-900 text-white text-sm font-semibold disabled:opacity-40 cursor-pointer"
                  >
                    {d.available ? 'Add' : 'Sold out'}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {tab === 'basket' && (
          <div className="p-4">
            {cart.length === 0 && <p className="text-center text-slate-400 mt-10">Your basket is empty.</p>}
            <ul className="divide-y divide-slate-200">
              {cart.map(i => (
                <li key={i.cart_item_id} className="py-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">{i.quantity}× {i.summary ?? i.dish_name}</p>
                    <p className="text-xs text-slate-500 tabular-nums">
                      {cur} {(Number(i.unit_price) * i.quantity).toFixed(2)}
                    </p>
                  </div>
                  <button
                    onClick={() => void remove(i.cart_item_id)}
                    className="shrink-0 min-h-[44px] px-3 text-sm text-red-600 font-semibold cursor-pointer"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>

            {totals && cart.length > 0 && (
              <div className="mt-4 bg-white rounded-xl border border-slate-200 p-4 text-sm space-y-1">
                <Row label="Subtotal" value={`${cur} ${totals.subtotal.toFixed(2)}`} />
                {totals.serviceCharge > 0 && <Row label="Service charge" value={`${cur} ${totals.serviceCharge.toFixed(2)}`} />}
                {totals.tax > 0 && <Row label="Tax" value={`${cur} ${totals.tax.toFixed(2)}`} />}
                <div className="flex justify-between font-bold pt-2 border-t border-slate-100">
                  <span>Total</span>
                  <span className="tabular-nums">{cur} {totals.total.toFixed(2)}</span>
                </div>
                <button
                  onClick={() => void send()}
                  className="w-full min-h-[52px] mt-3 rounded-xl bg-slate-900 text-white font-bold cursor-pointer"
                >
                  Send to kitchen
                </button>
                <p className="text-[11px] text-slate-500 text-center">
                  You pay at the end of your meal — this only sends the order.
                </p>
              </div>
            )}
          </div>
        )}

        {tab === 'orders' && (
          <div className="p-4 space-y-3">
            {orders.length === 0 && (
              <p className="text-center text-slate-400 mt-10">Nothing ordered yet.</p>
            )}
            {orders.map(o => <OrderCard key={o.orderId} order={o} currency={cur} />)}
          </div>
        )}
      </main>

      {toast && (
        <div className="shrink-0 mx-4 mb-2 px-4 py-3 rounded-xl bg-slate-900 text-white text-sm text-center">
          {toast}
        </div>
      )}

      <GuestVoice
        token={token}
        currency={cur}
        onCartChanged={() => { void loadCart(); }}
        onOrderPlaced={num => {
          void loadCart();
          void loadOrders();
          setTab('orders');
          setToast(num ? `Order #${num} sent to the kitchen` : 'Order sent to the kitchen');
        }}
      />

      <nav className="shrink-0 grid grid-cols-3 bg-white border-t border-slate-200 pb-[env(safe-area-inset-bottom)]">
        {([['menu', 'Menu'], ['basket', 'Basket'], ['orders', 'My orders']] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`min-h-[56px] text-sm font-semibold cursor-pointer ${
              tab === id ? 'text-slate-900' : 'text-slate-400'
            }`}
          >
            {label}
            {id === 'basket' && cartCount > 0 && (
              <span className="ml-1.5 text-xs bg-slate-900 text-white rounded-full px-2 py-0.5">{cartCount}</span>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}

// ── Order tracking ───────────────────────────────────────────────────────────

const STAGES = ['pending', 'confirmed', 'preparing', 'ready'] as const;
const STAGE_LABEL: Record<string, string> = {
  pending:   'Sent',
  confirmed: 'Accepted',
  preparing: 'Cooking',
  ready:     'Ready',
};

function OrderCard({ order, currency }: { order: TrackedOrder; currency: string }) {
  const idx     = STAGES.indexOf(order.status as typeof STAGES[number]);
  const done    = ['delivered'].includes(order.status);
  const stopped = ['cancelled', 'voided'].includes(order.status);
  const mins    = Math.max(0, Math.round((Date.now() - new Date(order.placedAt).getTime()) / 60000));

  return (
    <article className="bg-white rounded-xl border border-slate-200 p-4">
      <header className="flex justify-between items-baseline mb-3">
        <span className="font-bold">Order #{order.orderNumber ?? '—'}</span>
        <span className="text-xs text-slate-500">{mins} min ago</span>
      </header>

      {stopped ? (
        <p className="text-sm text-red-700">This order was cancelled. Please speak to a waiter.</p>
      ) : done ? (
        <p className="text-sm text-emerald-700 font-semibold">Served — enjoy your meal.</p>
      ) : (
        <ol className="flex items-center gap-1 mb-2">
          {STAGES.map((s, i) => (
            <li key={s} className="flex-1">
              <div className={`h-1.5 rounded-full ${i <= idx ? 'bg-emerald-500' : 'bg-slate-200'}`} />
              <span className={`block text-[10px] mt-1 ${i <= idx ? 'text-emerald-700 font-semibold' : 'text-slate-400'}`}>
                {STAGE_LABEL[s]}
              </span>
            </li>
          ))}
        </ol>
      )}

      <p className="text-sm font-semibold tabular-nums mt-2">
        {currency} {order.total.toFixed(2)}
      </p>
    </article>
  );
}

// ── bits ─────────────────────────────────────────────────────────────────────

/** /t/<slug>/<token> — the token is the last segment. */
function readTokenFromUrl(): string | null {
  const m = window.location.pathname.match(/^\/t\/[^/]+\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function Centre({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center h-full bg-slate-50 p-6">
      <div className="w-full max-w-sm text-center">{children}</div>
    </div>
  );
}

function Key({ children, onClick, disabled, muted }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; muted?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`min-h-[60px] rounded-xl border text-xl font-semibold disabled:opacity-40 cursor-pointer ${
        muted ? 'bg-slate-100 border-slate-200 text-slate-600 text-base' : 'bg-white border-slate-300'
      }`}
    >
      {children}
    </button>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-slate-600">
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
