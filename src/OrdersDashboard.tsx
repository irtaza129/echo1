import { useState, useEffect, useCallback, useRef } from 'react';
import { tenantFetch, getCurrentTenant } from './lib/apiClient';

type SelectedOption = {
  option_name: string;
  choice_name: string;
};

// Handles both Render-backend shape (dish_name / item_total) and local-order
// shape (name / summary / unit_price) so the same component works for all tenants.
type OrderItem = {
  dish_name?:        string;
  name?:             string;
  summary?:          string;
  quantity:          number;
  unit_price:        string | number;
  item_total?:       string | number;
  notes?:            string | null;
  selected_options?: SelectedOption[];
  modifiers?:        string[];
};

type Order = {
  id:              string;
  customer_name:   string;
  customer_phone:  string;
  order_type:      string;
  status:          string;
  total_amount?:   string | number;
  total?:          string | number;
  subtotal?:       string | number;
  notes?:          string | null;
  created_at:      string;
  items:           OrderItem[];
};

const TARGET_STATUS: Record<string, string> = {
  pending:   'preparing',
  confirmed: 'preparing',
  preparing: 'ready',
  ready:     'delivered',
};

// API only allows single-step transitions, so some targets need intermediate hops
const TRANSITION_STEPS: Record<string, string[]> = {
  'pending→preparing':  ['confirmed', 'preparing'],
  'ready→delivered':    ['out_for_delivery', 'delivered'],
};

const ADVANCE_LABEL: Record<string, string> = {
  pending:   'Start Preparing',
  confirmed: 'Start Preparing',
  preparing: 'Mark Ready',
  ready:     'Mark Delivered',
};

const STATUS_COLOR: Record<string, string> = {
  pending:   'bg-yellow-400',
  confirmed: 'bg-blue-400',
  preparing: 'bg-orange-400',
  ready:     'bg-green-500',
  delivered: 'bg-gray-400',
};

const STATUS_BADGE: Record<string, string> = {
  pending:   'bg-yellow-50 text-yellow-800 border-yellow-200',
  confirmed: 'bg-blue-50 text-blue-800 border-blue-200',
  preparing: 'bg-orange-50 text-orange-800 border-orange-200',
  ready:     'bg-green-50 text-green-800 border-green-200',
};

function getItemLabel(item: OrderItem): string {
  return item.dish_name ?? item.name ?? item.summary ?? '?';
}

function getItemTotal(item: OrderItem): number {
  if (item.item_total !== undefined) return parseFloat(String(item.item_total)) || 0;
  return (Number(item.unit_price) || 0) * (item.quantity || 1);
}

function getOrderTotal(order: Order): number {
  const raw = order.total_amount ?? order.total ?? order.subtotal;
  if (raw !== undefined) return parseFloat(String(raw)) || 0;
  return (order.items ?? []).reduce((s, i) => s + getItemTotal(i), 0);
}

function getModifiers(item: OrderItem): string[] {
  if (item.selected_options?.length) {
    return item.selected_options.map(o => `${o.option_name}: ${o.choice_name}`);
  }
  return item.modifiers ?? [];
}

function OrderCard({
  order,
  currency,
  onAdvance,
}: {
  order:     Order;
  currency:  string;
  onAdvance: (id: string, currentStatus: string) => void;
}) {
  const target  = TARGET_STATUS[order.status];
  const total   = getOrderTotal(order);
  const timeStr = new Date(order.created_at).toLocaleTimeString('en-PK', {
    hour: '2-digit', minute: '2-digit',
  });

  return (
    <div className="glass-panel p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex justify-between items-start gap-2">
        <div className="min-w-0">
          <p className="font-bold text-sm text-[#5A5A40] truncate">
            {order.customer_name || 'Guest'}
          </p>
          <p className="text-[10px] opacity-35 font-mono uppercase mt-0.5">
            #{order.id.slice(0, 8)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 bg-[#5A5A40]/8 text-[#5A5A40] rounded-lg font-medium">
            {(order.order_type ?? 'dine_in').replace('_', ' ')}
          </span>
          <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-medium uppercase tracking-wide ${STATUS_BADGE[order.status] ?? 'bg-gray-50 text-gray-700 border-gray-200'}`}>
            <div className={`w-1.5 h-1.5 rounded-full ${STATUS_COLOR[order.status] ?? 'bg-gray-400'}`} />
            {order.status}
          </div>
        </div>
      </div>

      {/* Items */}
      <div className="flex flex-col gap-1.5 border-t border-[#5A5A40]/8 pt-2.5">
        {(order.items || []).map((item, i) => (
          <div key={i}>
            <div className="flex justify-between items-start text-sm gap-2">
              <span className="text-[#3D3D33] font-medium leading-snug">
                {item.quantity}× {getItemLabel(item)}
              </span>
              <span className="font-mono text-xs opacity-55 whitespace-nowrap shrink-0 pt-0.5">
                {currency} {Math.round(getItemTotal(item))}
              </span>
            </div>
            {getModifiers(item).map((m, j) => (
              <p key={j} className="text-[11px] opacity-40 pl-4 leading-snug">{m}</p>
            ))}
            {item.notes && (
              <p className="text-[11px] italic opacity-40 pl-4 leading-snug">{item.notes}</p>
            )}
          </div>
        ))}
      </div>

      {order.notes && (
        <p className="text-[11px] italic opacity-45 border-t border-[#5A5A40]/8 pt-2 leading-snug">
          Note: {order.notes}
        </p>
      )}

      {/* Footer */}
      <div className="flex justify-between items-center pt-1">
        <span className="font-bold text-sm text-[#5A5A40]">{currency} {Math.round(total)}</span>
        <span className="text-[10px] opacity-35 font-mono">{timeStr}</span>
      </div>

      {target && (
        <button
          onClick={() => onAdvance(order.id, order.status)}
          className="w-full py-2 rounded-xl font-bold text-xs uppercase tracking-widest bg-[#5A5A40] text-[#F8F7F2] hover:bg-[#4a4a33] active:scale-95 transition-all cursor-pointer"
        >
          {ADVANCE_LABEL[order.status]}
        </button>
      )}
    </div>
  );
}

function ColumnHeader({ dotClass, title, count }: { dotClass: string; title: string; count: number }) {
  return (
    <div className="flex items-center gap-2.5 shrink-0 pb-1">
      <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotClass}`} />
      <h2 className="font-bold uppercase tracking-widest text-sm text-[#5A5A40]">
        {title}
        <span className="opacity-40 ml-1.5 font-normal">({count})</span>
      </h2>
    </div>
  );
}

export default function OrdersDashboard({ onBack, onLogout }: { onBack: () => void; onLogout?: () => void }) {
  const [incomingOrders,  setIncomingOrders]  = useState<Order[]>([]);
  const [preparingOrders, setPreparingOrders] = useState<Order[]>([]);
  const [readyOrders,     setReadyOrders]     = useState<Order[]>([]);
  const [currency,        setCurrency]        = useState('PKR');
  const [lastUpdated,     setLastUpdated]     = useState<Date | null>(null);
  const [error,           setError]           = useState<string | null>(null);
  const fetchingRef = useRef(false);

  const splitOrders = useCallback((orders: Order[]) => {
    const byTime = (a: Order, b: Order) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime();

    setIncomingOrders(
      orders.filter(o => o.status === 'pending' || o.status === 'confirmed').sort(byTime)
    );
    setPreparingOrders(orders.filter(o => o.status === 'preparing').sort(byTime));
    setReadyOrders(    orders.filter(o => o.status === 'ready').sort(byTime));
  }, []);

  const fetchOrders = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setError(null);
    try {
      const { tenantId } = getCurrentTenant();
      if (!tenantId) {
        setError('Not signed in — please log in to view your orders.');
        return;
      }
      const r = await tenantFetch('/api/orders/active');
      if (!r.ok) { setError(`Could not fetch orders (HTTP ${r.status})`); return; }
      const data = await r.json() as Order[];
      splitOrders(Array.isArray(data) ? data : []);
      setLastUpdated(new Date());
    } catch (err: unknown) {
      setError('Could not fetch orders: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      fetchingRef.current = false;
    }
  }, [splitOrders]);

  // Fetch currency symbol from tenant config once on mount
  useEffect(() => {
    tenantFetch('/api/admin/my-config')
      .then(r => r.ok ? r.json() : null)
      .then((cfg: { businessRules?: { currencySymbol?: string } } | null) => {
        if (cfg?.businessRules?.currencySymbol) setCurrency(cfg.businessRules.currencySymbol);
      })
      .catch(() => undefined);
  }, []);

  // Initial fetch + 6-second auto-refresh
  useEffect(() => {
    fetchOrders();
    const interval = setInterval(fetchOrders, 6_000);
    return () => clearInterval(interval);
  }, [fetchOrders]);

  const advanceStatus = useCallback(async (orderId: string, currentStatus: string) => {
    const target = TARGET_STATUS[currentStatus];
    if (!target) return;

    // Optimistic update: move the card to the target column immediately
    const moveOrder = (orders: Order[], status: string): [Order | undefined, Order[]] => {
      const idx = orders.findIndex(o => o.id === orderId);
      if (idx === -1) return [undefined, orders];
      const updated = { ...orders[idx], status };
      return [updated, orders.filter((_, i) => i !== idx)];
    };

    setIncomingOrders(prev => {
      const [found, rest] = moveOrder(prev, target);
      if (!found) return prev;
      if (target === 'preparing') setPreparingOrders(p => [...p, found].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      ));
      return rest;
    });
    setPreparingOrders(prev => {
      const [found, rest] = moveOrder(prev, target);
      if (!found) return prev;
      if (target === 'ready') setReadyOrders(p => [...p, found].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      ));
      return rest;
    });
    setReadyOrders(prev => {
      const [, rest] = moveOrder(prev, target);
      return rest;
    });

    // Fire API calls in background, then reconcile
    const key   = `${currentStatus}→${target}`;
    const steps = TRANSITION_STEPS[key] ?? [target];
    try {
      for (const step of steps) {
        const r = await tenantFetch(`/api/orders/${orderId}/status`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ status: step }),
        });
        if (!r.ok) { console.error(`[Dashboard] transition to "${step}" failed`); break; }
      }
    } catch (err) {
      console.error('[Dashboard] advanceStatus error:', err);
    }
    // Reconcile with server truth after the API call
    await fetchOrders();
  }, [fetchOrders]);

  return (
    <div className="flex flex-col h-full overflow-hidden select-none bg-[#F8F7F2] p-3 md:p-5 lg:p-7 gap-3 md:gap-5">

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 md:gap-4">
          <button
            onClick={onBack}
            className="text-xs uppercase tracking-widest opacity-50 hover:opacity-100 cursor-pointer transition-opacity font-semibold"
          >
            ← Kiosk
          </button>
          {onLogout && (
            <>
              <div className="w-px h-5 bg-[#5A5A40]/20" />
              <button
                onClick={onLogout}
                className="text-xs uppercase tracking-widest text-red-500 opacity-70 hover:opacity-100 cursor-pointer transition-opacity font-semibold"
              >
                Sign Out
              </button>
            </>
          )}
          <div className="w-px h-6 bg-[#5A5A40]/20" />
          <div>
            <h1 className="text-lg md:text-xl lg:text-2xl font-serif font-bold text-[#5A5A40]">
              Live Orders
            </h1>
            <p className="text-[10px] opacity-40 uppercase tracking-widest mt-0.5 hidden sm:block">
              {lastUpdated
                ? `Updated ${lastUpdated.toLocaleTimeString()} · auto-refresh every 6s`
                : 'Loading…'}
            </p>
          </div>
        </div>
        <button
          onClick={fetchOrders}
          className="px-4 py-2 glass-panel text-xs uppercase tracking-widest font-bold text-[#5A5A40] hover:bg-white/80 transition-colors cursor-pointer rounded-xl"
        >
          ↻ Refresh
        </button>
      </div>

      {error && (
        <div className="glass-panel p-4 text-red-600 text-sm shrink-0 border border-red-200/50">
          {error}
        </div>
      )}

      {/* Order board */}
      <div className="flex-1 flex flex-col gap-4 overflow-y-auto md:grid md:grid-cols-3 md:gap-5 md:min-h-0 md:overflow-hidden">

        {/* Column 1: Incoming */}
        <div className="flex flex-col gap-3 md:min-h-0">
          <ColumnHeader dotClass="bg-yellow-400" title="Incoming" count={incomingOrders.length} />
          <div className="flex flex-col gap-3 md:flex-1 md:overflow-y-auto md:min-h-0 md:pr-1">
            {incomingOrders.length === 0
              ? <p className="text-xs opacity-35 italic text-center pt-8 md:pt-12">No incoming orders</p>
              : incomingOrders.map(o => (
                  <OrderCard key={o.id} order={o} currency={currency} onAdvance={advanceStatus} />
                ))
            }
          </div>
        </div>

        {/* Column 2: Preparing */}
        <div className="flex flex-col gap-3 md:min-h-0 border-t border-[#5A5A40]/10 pt-4 md:border-0 md:pt-0">
          <ColumnHeader dotClass="bg-orange-400" title="Preparing" count={preparingOrders.length} />
          <div className="flex flex-col gap-3 md:flex-1 md:overflow-y-auto md:min-h-0 md:pr-1">
            {preparingOrders.length === 0
              ? <p className="text-xs opacity-35 italic text-center pt-8 md:pt-12">No orders preparing</p>
              : preparingOrders.map(o => (
                  <OrderCard key={o.id} order={o} currency={currency} onAdvance={advanceStatus} />
                ))
            }
          </div>
        </div>

        {/* Column 3: Ready */}
        <div className="flex flex-col gap-3 md:min-h-0 border-t border-[#5A5A40]/10 pt-4 md:border-0 md:pt-0">
          <ColumnHeader dotClass="bg-green-500" title="Ready" count={readyOrders.length} />
          <div className="flex flex-col gap-3 md:flex-1 md:overflow-y-auto md:min-h-0 md:pr-1">
            {readyOrders.length === 0
              ? <p className="text-xs opacity-35 italic text-center pt-8 md:pt-12">No orders ready</p>
              : readyOrders.map(o => (
                  <OrderCard key={o.id} order={o} currency={currency} onAdvance={advanceStatus} />
                ))
            }
          </div>
        </div>

      </div>
    </div>
  );
}
