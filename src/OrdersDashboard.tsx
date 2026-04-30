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

const NEXT_STATUS: Record<string, string> = {
  pending:   'preparing',
  confirmed: 'preparing',
  preparing: 'ready',
  ready:     'delivered',
};

const ADVANCE_LABEL: Record<string, string> = {
  pending:   'Start Preparing',
  confirmed: 'Start Preparing',
  preparing: 'Mark Ready',
  ready:     'Complete',
};

const STATUS_DOT: Record<string, string> = {
  pending:   'bg-yellow-400',
  confirmed: 'bg-blue-400',
  preparing: 'bg-orange-400',
  ready:     'bg-green-500',
};

function OrderCard({
  order,
  onAdvance,
}: {
  order: Order;
  onAdvance: (id: string, next: string) => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const next = NEXT_STATUS[order.status];

  const handleAdvance = async () => {
    setLoading(true);
    await onAdvance(order.id, next);
    setLoading(false);
  };

  const total = parseFloat(String(order.total_amount)) || 0;

  return (
    <div className="glass-panel p-5 flex flex-col gap-3">
      {/* Header row */}
      <div className="flex justify-between items-start">
        <div>
          <p className="font-bold text-[#5A5A40]">{order.customer_name || 'Guest'}</p>
          <p className="text-[10px] opacity-40 font-mono uppercase">{order.id.slice(0, 8)}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-[10px] uppercase tracking-widest px-2 py-1 bg-[#5A5A40]/10 rounded-lg">
            {order.order_type.replace('_', ' ')}
          </span>
          <div className="flex items-center gap-1">
            <div className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[order.status] ?? 'bg-gray-400'}`}></div>
            <span className="text-[10px] opacity-50 uppercase tracking-widest">{order.status}</span>
          </div>
        </div>
      </div>

      {/* Items */}
      <div className="flex flex-col gap-1.5 border-t border-[#5A5A40]/10 pt-2">
        {(order.items || []).map((item, i) => (
          <div key={i}>
            <div className="flex justify-between text-sm">
              <span className="opacity-80">{item.quantity}× {item.dish_name}</span>
              <span className="font-mono opacity-60">
                PKR {Math.round(parseFloat(String(item.item_total)))}
              </span>
            </div>
            {(item.selected_options || []).map((opt, j) => (
              <p key={j} className="text-[11px] opacity-40 pl-4">
                {opt.option_name}: {opt.choice_name}
              </p>
            ))}
            {item.notes && (
              <p className="text-[11px] italic opacity-40 pl-4">{item.notes}</p>
            )}
          </div>
        ))}
      </div>

      {order.notes && (
        <p className="text-[11px] italic opacity-50 border-t border-[#5A5A40]/10 pt-2">
          Note: {order.notes}
        </p>
      )}

      {/* Footer */}
      <div className="flex justify-between items-center">
        <span className="font-bold text-sm">PKR {Math.round(total)}</span>
        <span className="text-[10px] opacity-40">
          {new Date(order.created_at).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {next && (
        <button
          onClick={handleAdvance}
          disabled={loading}
          className="w-full py-2 rounded-lg font-bold text-xs uppercase tracking-widest bg-[#5A5A40] text-[#F8F7F2] hover:bg-[#4a4a33] transition-colors disabled:opacity-40 cursor-pointer"
        >
          {loading ? '...' : ADVANCE_LABEL[order.status]}
        </button>
      )}
    </div>
  );
}

export default function OrdersDashboard({ onBack }: { onBack: () => void }) {
  const [leftOrders, setLeftOrders]   = useState<Order[]>([]);
  const [readyOrders, setReadyOrders] = useState<Order[]>([]);
  const [loading, setLoading]         = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError]             = useState<string | null>(null);

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

      const extract = (res: any): Order[] => res.items ?? res.orders ?? res.data ?? [];

      // Merge pending + confirmed + preparing, oldest first
      const merged = [
        ...extract(pendingRes),
        ...extract(confirmedRes),
        ...extract(preparingRes),
      ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

      setLeftOrders(merged);
      setReadyOrders(extract(readyRes));
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

  const advanceStatus = async (orderId: string, nextStatus: string) => {
    try {
      await fetch(`/api/orders/${orderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      await fetchOrders();
    } catch (err: any) {
      console.error('[Dashboard] advanceStatus error:', err);
    }
  };

  return (
    <div className="p-8 flex flex-col gap-6 w-full h-full select-none overflow-hidden">

      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-5">
          <button
            onClick={onBack}
            className="text-xs uppercase tracking-widest opacity-50 hover:opacity-100 cursor-pointer transition-opacity"
          >
            ← Kiosk
          </button>
          <div>
            <h1 className="text-2xl font-serif font-bold text-[#5A5A40]">Live Orders</h1>
            <p className="text-[10px] opacity-40 uppercase tracking-widest">
              {lastUpdated
                ? `Updated ${lastUpdated.toLocaleTimeString()} · auto-refresh every 60s`
                : 'Loading...'}
            </p>
          </div>
        </div>
        <button
          onClick={fetchOrders}
          disabled={loading}
          className="px-5 py-2 glass-panel text-xs uppercase tracking-widest font-bold text-[#5A5A40] hover:bg-white/80 transition-colors disabled:opacity-40 cursor-pointer rounded-2xl"
        >
          {loading ? '...' : '↻  Refresh'}
        </button>
      </div>

      {error && (
        <div className="glass-panel p-4 text-red-500 text-sm flex-shrink-0">{error}</div>
      )}

      {/* Two columns */}
      <div className="flex-1 grid grid-cols-2 gap-6 min-h-0">

        {/* Left: Pending + Confirmed + Preparing */}
        <div className="flex flex-col gap-4 min-h-0">
          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="flex gap-1">
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-400"></div>
              <div className="w-2.5 h-2.5 rounded-full bg-orange-400"></div>
            </div>
            <h2 className="font-bold uppercase tracking-widest text-sm text-[#5A5A40]">
              Incoming & Preparing
              <span className="opacity-40 ml-1">({leftOrders.length})</span>
            </h2>
          </div>
          <div className="flex-1 flex flex-col gap-3 overflow-y-auto pr-1">
            {leftOrders.length === 0 ? (
              <p className="text-xs opacity-40 italic text-center mt-16">No active orders</p>
            ) : (
              leftOrders.map(o => (
                <OrderCard key={o.id} order={o} onAdvance={advanceStatus} />
              ))
            )}
          </div>
        </div>

        {/* Right: Ready */}
        <div className="flex flex-col gap-4 min-h-0">
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="w-2.5 h-2.5 rounded-full bg-green-500"></div>
            <h2 className="font-bold uppercase tracking-widest text-sm text-[#5A5A40]">
              Ready
              <span className="opacity-40 ml-1">({readyOrders.length})</span>
            </h2>
          </div>
          <div className="flex-1 flex flex-col gap-3 overflow-y-auto pr-1">
            {readyOrders.length === 0 ? (
              <p className="text-xs opacity-40 italic text-center mt-16">No orders ready</p>
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
