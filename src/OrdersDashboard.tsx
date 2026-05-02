import { useState, useEffect, useCallback } from 'react';

type SelectedOption = {
  option_name: string;
  choice_name: string;
};

type OrderItem = {
  dish_name: string;
  quantity: number;
  unit_price: string | number;
  item_total: string | number;
  notes?: string | null;
  selected_options?: SelectedOption[];
};

type Order = {
  id: string;
  customer_name: string;
  customer_phone: string;
  order_type: string;
  status: string;
  total_amount: string | number;
  subtotal: string | number;
  notes?: string | null;
  created_at: string;
  items: OrderItem[];
};

// The status we want the order to end up in after clicking the button
const TARGET_STATUS: Record<string, string> = {
  pending:   'preparing',
  confirmed: 'preparing',
  preparing: 'ready',
  ready:     'delivered',
};

// API only allows single-step transitions, so some targets need intermediate hops:
// pending → confirmed → preparing
// ready   → out_for_delivery → delivered
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

function OrderCard({
  order,
  onAdvance,
}: {
  order: Order;
  onAdvance: (id: string, currentStatus: string, targetStatus: string) => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const target = TARGET_STATUS[order.status];
  const total  = parseFloat(String(order.total_amount)) || 0;

  const handleAdvance = async () => {
    setLoading(true);
    await onAdvance(order.id, order.status, target);
    setLoading(false);
  };

  const timeStr = new Date(order.created_at).toLocaleTimeString('en-PK', {
    hour: '2-digit',
    minute: '2-digit',
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
            {order.order_type.replace('_', ' ')}
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
                {item.quantity}× {item.dish_name}
              </span>
              <span className="font-mono text-xs opacity-55 whitespace-nowrap shrink-0 pt-0.5">
                PKR {Math.round(parseFloat(String(item.item_total)))}
              </span>
            </div>
            {(item.selected_options || []).map((opt, j) => (
              <p key={j} className="text-[11px] opacity-40 pl-4 leading-snug">
                {opt.option_name}: {opt.choice_name}
              </p>
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
        <span className="font-bold text-sm text-[#5A5A40]">PKR {Math.round(total)}</span>
        <span className="text-[10px] opacity-35 font-mono">{timeStr}</span>
      </div>

      {target && (
        <button
          onClick={handleAdvance}
          disabled={loading}
          className="w-full py-2 rounded-xl font-bold text-xs uppercase tracking-widest bg-[#5A5A40] text-[#F8F7F2] hover:bg-[#4a4a33] active:scale-95 transition-all disabled:opacity-40 cursor-pointer"
        >
          {loading ? 'Updating...' : ADVANCE_LABEL[order.status]}
        </button>
      )}
    </div>
  );
}

function ColumnHeader({
  dotClass,
  title,
  count,
}: {
  dotClass: string;
  title: string;
  count: number;
}) {
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

export default function OrdersDashboard({ onBack }: { onBack: () => void }) {
  const [incomingOrders,  setIncomingOrders]  = useState<Order[]>([]);
  const [preparingOrders, setPreparingOrders] = useState<Order[]>([]);
  const [readyOrders,     setReadyOrders]     = useState<Order[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error,      setError]      = useState<string | null>(null);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pendingRes, confirmedRes, preparingRes, readyRes] = await Promise.all([
        fetch('/api/orders?status=pending&per_page=50').then(r => r.json()),
        fetch('/api/orders?status=confirmed&per_page=50').then(r => r.json()),
        fetch('/api/orders?status=preparing&per_page=50').then(r => r.json()),
        fetch('/api/orders?status=ready&per_page=50').then(r => r.json()),
      ]);

      const extract = (res: any): Order[] =>
        (res.items ?? res.orders ?? res.data ?? []) as Order[];

      const byTime = (a: Order, b: Order) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime();

      setIncomingOrders(
        [...extract(pendingRes), ...extract(confirmedRes)].sort(byTime)
      );
      setPreparingOrders(extract(preparingRes).sort(byTime));
      setReadyOrders(extract(readyRes).sort(byTime));
      setLastUpdated(new Date());
    } catch (err: any) {
      setError('Could not fetch orders: ' + err.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchOrders();
    const interval = setInterval(fetchOrders, 60_000);
    return () => clearInterval(interval);
  }, [fetchOrders]);

  const advanceStatus = async (orderId: string, currentStatus: string, targetStatus: string) => {
    const key   = `${currentStatus}→${targetStatus}`;
    const steps = TRANSITION_STEPS[key] ?? [targetStatus];
    try {
      for (const step of steps) {
        const r = await fetch(`/api/orders/${orderId}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: step }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          console.error(`[Dashboard] transition to "${step}" failed:`, body);
          break;
        }
      }
    } catch (err: any) {
      console.error('[Dashboard] advanceStatus error:', err);
    }
    await fetchOrders();
  };

  return (
    <div className="flex flex-col h-full overflow-hidden select-none bg-[#F8F7F2] p-5 lg:p-7 gap-5">

      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className="text-xs uppercase tracking-widest opacity-50 hover:opacity-100 cursor-pointer transition-opacity font-semibold"
          >
            ← Kiosk
          </button>
          <div className="w-px h-6 bg-[#5A5A40]/20" />
          <div>
            <h1 className="text-xl lg:text-2xl font-serif font-bold text-[#5A5A40]">
              Live Orders
            </h1>
            <p className="text-[10px] opacity-40 uppercase tracking-widest mt-0.5">
              {lastUpdated
                ? `Updated ${lastUpdated.toLocaleTimeString()} · auto-refresh every 60s`
                : 'Loading...'}
            </p>
          </div>
        </div>
        <button
          onClick={fetchOrders}
          disabled={loading}
          className="px-4 py-2 glass-panel text-xs uppercase tracking-widest font-bold text-[#5A5A40] hover:bg-white/80 transition-colors disabled:opacity-40 cursor-pointer rounded-xl"
        >
          {loading ? '...' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div className="glass-panel p-4 text-red-600 text-sm shrink-0 border border-red-200/50">
          {error}
        </div>
      )}

      {/* 3-column order board */}
      <div className="flex-1 grid grid-cols-3 gap-5 min-h-0">

        {/* Column 1: Incoming (pending + confirmed) */}
        <div className="flex flex-col gap-3 min-h-0">
          <ColumnHeader
            dotClass="bg-yellow-400"
            title="Incoming"
            count={incomingOrders.length}
          />
          <div className="flex-1 flex flex-col gap-3 overflow-y-auto min-h-0 pr-1">
            {incomingOrders.length === 0 ? (
              <p className="text-xs opacity-35 italic text-center pt-12">No incoming orders</p>
            ) : (
              incomingOrders.map(o => (
                <OrderCard key={o.id} order={o} onAdvance={advanceStatus} />
              ))
            )}
          </div>
        </div>

        {/* Column 2: Preparing */}
        <div className="flex flex-col gap-3 min-h-0">
          <ColumnHeader
            dotClass="bg-orange-400"
            title="Preparing"
            count={preparingOrders.length}
          />
          <div className="flex-1 flex flex-col gap-3 overflow-y-auto min-h-0 pr-1">
            {preparingOrders.length === 0 ? (
              <p className="text-xs opacity-35 italic text-center pt-12">No orders preparing</p>
            ) : (
              preparingOrders.map(o => (
                <OrderCard key={o.id} order={o} onAdvance={advanceStatus} />
              ))
            )}
          </div>
        </div>

        {/* Column 3: Ready */}
        <div className="flex flex-col gap-3 min-h-0">
          <ColumnHeader
            dotClass="bg-green-500"
            title="Ready"
            count={readyOrders.length}
          />
          <div className="flex-1 flex flex-col gap-3 overflow-y-auto min-h-0 pr-1">
            {readyOrders.length === 0 ? (
              <p className="text-xs opacity-35 italic text-center pt-12">No orders ready</p>
            ) : (
              readyOrders.map(o => (
                <OrderCard key={o.id} order={o} onAdvance={advanceStatus} />
              ))
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
