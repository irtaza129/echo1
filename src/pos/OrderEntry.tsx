import { useEffect, useMemo, useState } from 'react';
import { tenantFetch } from '../lib/apiClient';
import type { Operator } from './PinGate';

// Ringing an order in at the counter.
//
// The basket lives in component state and is sent as one payload. A dine-in tab
// that grows over an hour uses POST /orders/:id/items instead — this screen is
// for the first round, or for a takeaway that is rung and paid in one go.
//
// Totals are NEVER computed here. Every figure comes from POST /api/pos/quote,
// which runs the same computeTotals() the order will be written with. A till
// that does its own arithmetic will eventually disagree with the receipt, and
// the customer is the one who finds out.

export interface MenuOptionChoice { id: number; name: string; price: number }
export interface MenuOptionGroup {
  id: number; name: string; required: boolean; multiselect: boolean;
  minSelect: number; maxSelect: number; choices: MenuOptionChoice[];
}
export interface MenuDish {
  id: string; dish_id: number; name: string; description: string;
  price: number; available: boolean; category: string;
  optionGroups?: MenuOptionGroup[];
}
interface MenuCategory { id: string; name: string; items: MenuDish[] }

export interface BasketLine {
  key:        string;
  dishId?:    number;
  dishName:   string;
  quantity:   number;
  unitPrice:  number;
  selectedOptions: { option_name?: string; choice_name: string }[];
  notes?:     string | null;
  seatNo?:    number | null;
}

export interface Totals {
  subtotal: number; discount: number; serviceCharge: number; tax: number; total: number;
}

export default function OrderEntry({
  operator, currency, onPlaced,
}: {
  operator: Operator;
  currency: string;
  onPlaced: (orderId: string) => void;
}) {
  const [menu,     setMenu]     = useState<MenuCategory[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [basket,   setBasket]   = useState<BasketLine[]>([]);
  const [totals,   setTotals]   = useState<Totals | null>(null);
  const [orderType, setOrderType] = useState('dine_in');
  const [sheetFor, setSheetFor] = useState<MenuDish | null>(null);
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        // /api/pos/menu, not /api/menu. The Till always writes its orders to
        // our own Postgres (see the note on the server route), so it has to
        // read the SAME database's menu — never whatever a tenant's voice
        // channels happen to be configured to use, which may have no dish ids
        // this screen can understand at all.
        const res = await tenantFetch('/api/pos/menu');
        if (!res.ok) throw new Error(`menu ${res.status}`);
        const data = await res.json() as MenuCategory[];
        setMenu(data);
        setCategory(data[0]?.id ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  // Re-quote whenever the basket changes. Debounced because tapping "+" five
  // times quickly should cost one round trip, not five.
  useEffect(() => {
    if (basket.length === 0) { setTotals(null); return; }
    const id = setTimeout(() => { void quote(); }, 200);
    return () => clearTimeout(id);

    async function quote() {
      try {
        const res = await tenantFetch('/api/pos/quote', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ items: basket.map(toApiItem) }),
        });
        if (!res.ok) throw new Error(`quote ${res.status}`);
        setTotals(await res.json() as Totals);
      } catch (err) {
        // A failed quote must not show a stale total next to a changed basket.
        setTotals(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [basket]);

  const visible = useMemo(
    () => menu.find(c => c.id === category)?.items ?? [],
    [menu, category],
  );

  function addLine(dish: MenuDish, options: MenuOptionChoice[] = [], groups: MenuOptionGroup[] = []) {
    const modPrice = options.reduce((s, o) => s + o.price, 0);
    const labels   = options.map(o => ({
      option_name: groups.find(g => g.choices.some(c => c.id === o.id))?.name,
      choice_name: o.name,
    }));

    setBasket(prev => {
      // Identical lines stack rather than repeating, but only when the
      // modifiers match too — "Pulao (leg)" and "Pulao (chest)" are different
      // things on the kitchen ticket.
      //
      // dish.dish_id is required by the menu this screen fetches (/api/pos/menu
      // always includes it), but a defensive check stays here rather than
      // trusting that. A missing id must never be treated as a MATCHING id: if
      // it were, tapping two different dishes would both produce the same
      // signature and the second tap would silently add to the first dish's
      // line instead of creating its own — invisible in the UI, wrong on the
      // kitchen ticket. Never stacking beats stacking the wrong thing.
      const sig = dish.dish_id != null
        ? `${dish.dish_id}|${labels.map(l => l.choice_name).sort().join(',')}`
        : null;
      const hit = sig ? prev.find(l => l.key.startsWith(sig)) : undefined;
      if (hit) return prev.map(l => (l === hit ? { ...l, quantity: l.quantity + 1 } : l));

      return [...prev, {
        key:       `${sig ?? 'no-id'}|${Date.now()}|${Math.random()}`,
        dishId:    dish.dish_id,
        dishName:  dish.name,
        quantity:  1,
        unitPrice: dish.price + modPrice,
        selectedOptions: labels,
      }];
    });
  }

  function pick(dish: MenuDish) {
    const groups = dish.optionGroups ?? [];
    // Only open the sheet when there is a choice to make. Forcing a cashier
    // through a modal to add a bottle of water is how a till gets slow.
    if (groups.length === 0) { addLine(dish); return; }
    setSheetFor(dish);
  }

  function setQty(key: string, delta: number) {
    setBasket(prev => prev
      .map(l => (l.key === key ? { ...l, quantity: l.quantity + delta } : l))
      .filter(l => l.quantity > 0));
  }

  async function place() {
    setBusy(true); setError(null);
    try {
      const res = await tenantFetch('/api/pos/orders', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ items: basket.map(toApiItem), orderType }),
      });
      const body = await res.json() as { error?: string; order?: { id: string } };
      if (!res.ok || !body.order) throw new Error(body.error ?? `HTTP ${res.status}`);

      setBasket([]);
      setTotals(null);
      onPlaced(body.order.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col lg:flex-row gap-4 h-full min-h-0">
      {/* Menu */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex gap-2 overflow-x-auto pb-2 shrink-0">
          {menu.map(c => (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              className={`shrink-0 min-h-[44px] px-4 rounded-xl text-sm font-semibold border transition cursor-pointer ${
                category === c.id
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto">
          {visible.length === 0 && (
            <p className="text-sm text-slate-500 mt-8 text-center">
              No items in this category.
            </p>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">
            {visible.map(d => (
              <button
                key={d.id}
                onClick={() => pick(d)}
                disabled={!d.available}
                className="min-h-[5.5rem] p-3 text-left bg-white rounded-xl border border-slate-200 hover:border-slate-400 disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer"
              >
                <div className="font-semibold text-sm leading-tight mb-1">{d.name}</div>
                <div className="text-xs text-slate-500 tabular-nums">{currency} {d.price.toFixed(2)}</div>
                {!d.available && <div className="text-[10px] text-red-600 mt-1">Unavailable</div>}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Basket */}
      <aside className="w-full lg:w-80 shrink-0 flex flex-col bg-white rounded-xl border border-slate-200 min-h-0">
        <div className="p-3 border-b border-slate-100 shrink-0">
          <div className="flex gap-1">
            {['dine_in', 'takeaway', 'delivery'].map(t => (
              <button
                key={t}
                onClick={() => setOrderType(t)}
                className={`flex-1 min-h-[40px] rounded-lg text-xs font-semibold capitalize border transition cursor-pointer ${
                  orderType === t
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-600 border-slate-300'
                }`}
              >
                {t.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-auto p-3 space-y-2">
          {basket.length === 0 && (
            <p className="text-sm text-slate-400 text-center mt-8">Tap an item to start.</p>
          )}
          {basket.map(l => (
            <div key={l.key} className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium leading-tight truncate">{l.dishName}</div>
                {l.selectedOptions.length > 0 && (
                  <div className="text-[11px] text-slate-500 truncate">
                    {l.selectedOptions.map(o => o.choice_name).join(', ')}
                  </div>
                )}
                <div className="text-xs text-slate-500 tabular-nums">
                  {currency} {(l.unitPrice * l.quantity).toFixed(2)}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <QtyButton onClick={() => setQty(l.key, -1)}>−</QtyButton>
                <span className="w-6 text-center text-sm font-semibold tabular-nums">{l.quantity}</span>
                <QtyButton onClick={() => setQty(l.key, +1)}>+</QtyButton>
              </div>
            </div>
          ))}
        </div>

        <div className="p-3 border-t border-slate-100 shrink-0 space-y-1 text-sm">
          {totals ? (
            <>
              <Line label="Subtotal" value={totals.subtotal} currency={currency} />
              {totals.discount      > 0 && <Line label="Discount"       value={-totals.discount} currency={currency} />}
              {totals.serviceCharge > 0 && <Line label="Service charge" value={totals.serviceCharge} currency={currency} />}
              {totals.tax           > 0 && <Line label="Tax"            value={totals.tax} currency={currency} />}
              <div className="flex justify-between font-bold pt-1 border-t border-slate-100">
                <span>Total</span>
                <span className="tabular-nums">{currency} {totals.total.toFixed(2)}</span>
              </div>
            </>
          ) : (
            <p className="text-xs text-slate-400 text-center py-2">
              {basket.length > 0 ? 'Pricing…' : 'No items yet'}
            </p>
          )}

          {error && <p className="text-xs text-red-700">{error}</p>}

          <button
            onClick={() => void place()}
            disabled={busy || basket.length === 0 || !totals}
            className="w-full min-h-[48px] mt-2 rounded-xl bg-slate-900 text-white font-semibold disabled:opacity-40 cursor-pointer"
          >
            {busy ? 'Placing…' : 'Place order'}
          </button>
          <p className="text-[10px] text-slate-400 text-center">Rung in by {operator.email}</p>
        </div>
      </aside>

      {sheetFor && (
        <ModifierSheet
          dish={sheetFor}
          currency={currency}
          onCancel={() => setSheetFor(null)}
          onConfirm={(choices) => {
            addLine(sheetFor, choices, sheetFor.optionGroups ?? []);
            setSheetFor(null);
          }}
        />
      )}
    </div>
  );
}

// ── Modifier sheet ───────────────────────────────────────────────────────────

function ModifierSheet({
  dish, currency, onCancel, onConfirm,
}: {
  dish: MenuDish;
  currency: string;
  onCancel: () => void;
  onConfirm: (choices: MenuOptionChoice[]) => void;
}) {
  const groups = dish.optionGroups ?? [];
  const [picked, setPicked] = useState<Record<number, number[]>>({});

  function toggle(group: MenuOptionGroup, choiceId: number) {
    setPicked(prev => {
      const current = prev[group.id] ?? [];
      if (!group.multiselect) return { ...prev, [group.id]: [choiceId] };
      if (current.includes(choiceId)) {
        return { ...prev, [group.id]: current.filter(c => c !== choiceId) };
      }
      // Respect the group's own ceiling rather than letting the kitchen receive
      // a ticket with four sauces on a two-sauce dish.
      if (current.length >= group.maxSelect) return prev;
      return { ...prev, [group.id]: [...current, choiceId] };
    });
  }

  // Required groups gate the confirm button. This mirrors what the server does
  // in PosAdapter.resolveItem for the voice channel, so a dish cannot be sold
  // without its size through one door and not the other.
  const unmet = groups.filter(g => (picked[g.id]?.length ?? 0) < (g.required ? Math.max(1, g.minSelect) : 0));

  const chosen = groups.flatMap(g =>
    (picked[g.id] ?? []).map(id => g.choices.find(c => c.id === id)!).filter(Boolean));
  const extra = chosen.reduce((s, c) => s + c.price, 0);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl max-h-[85vh] flex flex-col">
        <header className="p-4 border-b border-slate-100 shrink-0">
          <h2 className="font-bold">{dish.name}</h2>
          <p className="text-xs text-slate-500 tabular-nums">
            {currency} {(dish.price + extra).toFixed(2)}
          </p>
        </header>

        <div className="flex-1 overflow-auto p-4 space-y-4">
          {groups.map(g => (
            <section key={g.id}>
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                {g.name}
                {g.required && <span className="text-red-600 ml-1">required</span>}
                {g.multiselect && <span className="font-normal normal-case ml-1">(up to {g.maxSelect})</span>}
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {g.choices.map(c => {
                  const on = (picked[g.id] ?? []).includes(c.id);
                  return (
                    <button
                      key={c.id}
                      onClick={() => toggle(g, c.id)}
                      className={`min-h-[44px] px-3 rounded-lg border text-sm text-left transition cursor-pointer ${
                        on ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-300'
                      }`}
                    >
                      {c.name}
                      {c.price > 0 && <span className="block text-[11px] opacity-70 tabular-nums">+{c.price.toFixed(2)}</span>}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <footer className="p-4 border-t border-slate-100 shrink-0 flex gap-2">
          <button onClick={onCancel} className="flex-1 min-h-[48px] rounded-xl border border-slate-300 font-semibold cursor-pointer">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(chosen)}
            disabled={unmet.length > 0}
            className="flex-1 min-h-[48px] rounded-xl bg-slate-900 text-white font-semibold disabled:opacity-40 cursor-pointer"
          >
            {unmet.length > 0 ? `Choose ${unmet[0].name}` : 'Add'}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ── bits ─────────────────────────────────────────────────────────────────────

function QtyButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-9 h-9 rounded-lg border border-slate-300 font-bold text-slate-700 hover:bg-slate-50 cursor-pointer"
    >
      {children}
    </button>
  );
}

function Line({ label, value, currency }: { label: string; value: number; currency: string }) {
  return (
    <div className="flex justify-between text-slate-600">
      <span>{label}</span>
      <span className="tabular-nums">{currency} {value.toFixed(2)}</span>
    </div>
  );
}

function toApiItem(l: BasketLine) {
  return {
    dishId:          l.dishId,
    dishName:        l.dishName,
    quantity:        l.quantity,
    unitPrice:       l.unitPrice,
    selectedOptions: l.selectedOptions,
    notes:           l.notes ?? null,
    seatNo:          l.seatNo ?? null,
  };
}
