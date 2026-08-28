import { useCallback, useEffect, useMemo, useState } from 'react';
import { tenantFetch } from '../lib/apiClient';
import { useEventStream, type StreamEvent } from '../lib/useEventStream';

// The kitchen display.
//
// Replaces the 60-second polling board with a live one, and bumps per LINE
// rather than per order — the drinks are ready long before the karahi, and a
// board that can only bump whole orders forces the kitchen to either lie or
// wait.
//
// Designed to be read at arm's length across a hot room by someone whose hands
// are full: big type, no hover states, colour that means one thing (how long
// this has been waiting) rather than five.

export interface KdsLine {
  itemId:    string;
  name:      string;
  quantity:  number;
  modifiers: string[];
  notes:     string | null;
  seat:      number | null;
  course:    string | null;
  startedAt: string | null;
}

export interface KdsTicket {
  orderId:     string;
  orderNumber: number | null;
  orderType:   string;
  tableLabel:  string | null;
  source:      string;
  placedAt:    string;
  lines:       KdsLine[];
}

interface Station { id: string; name: string }

// How long a ticket may sit before the board escalates. Set against what a
// kitchen actually promises rather than arbitrarily: under 5 min is fine, past
// 10 someone is waiting and knows it.
const WARN_S   = 5 * 60;
const URGENT_S = 10 * 60;

const SOURCE_LABEL: Record<string, string> = {
  pos: 'Till', kiosk: 'Kiosk', phone: 'Phone', whatsapp: 'WhatsApp', qr: 'Table', web: 'Web',
};

export default function KitchenDisplay({ staffId }: { staffId: string }) {
  const [tickets,  setTickets]  = useState<KdsTicket[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [station,  setStation]  = useState<string | null>(null);
  const [error,    setError]    = useState<string | null>(null);
  const [loaded,   setLoaded]   = useState(false);

  const load = useCallback(async () => {
    try {
      const qs  = station ? `?station=${encodeURIComponent(station)}` : '';
      const res = await tenantFetch(`/api/pos/kds/tickets${qs}`);
      if (!res.ok) throw new Error(`tickets ${res.status}`);
      setTickets(await res.json() as KdsTicket[]);
      setError(null);
    } catch (err) {
      // Surfaced, never swallowed. A board silently showing stale tickets is
      // how food stops being cooked without anyone noticing.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, [station]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    void (async () => {
      const res = await tenantFetch('/api/pos/kds/stations');
      if (res.ok) setStations(await res.json() as Station[]);
    })();
  }, []);

  // Every one of these changes what should be on the board, and none of them
  // carries enough detail to patch in place — a new order has lines this screen
  // has never seen.
  const onEvent = useCallback((e: StreamEvent) => {
    if (['order.created', 'order.status', 'order.voided', 'kds.bumped', 'kds.recalled']
      .includes(e.type)) void load();
  }, [load]);

  useEventStream(onEvent, { onResync: load });

  // Re-render every second so the timers stay honest between events.
  const [, tick] = useState(0);
  useEffect(() => {
    if (tickets.length === 0) return;
    const id = setInterval(() => tick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [tickets.length]);

  async function act(itemId: string, action: 'bump' | 'recall') {
    // Optimistic: a cook taps bump and the card must go immediately. The event
    // that follows reconciles it, and load() puts it back if the write failed.
    if (action === 'bump') {
      setTickets(prev => prev
        .map(t => ({ ...t, lines: t.lines.filter(l => l.itemId !== itemId) }))
        .filter(t => t.lines.length > 0));
    }
    try {
      await tenantFetch(`/api/pos/kds/items/${itemId}/${action}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ staffId }),
      });
    } finally {
      void load();
    }
  }

  const oldest = useMemo(
    () => tickets.reduce((acc, t) => Math.min(acc, new Date(t.placedAt).getTime()), Date.now()),
    [tickets],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 flex items-center gap-2 mb-3 flex-wrap">
        <button
          onClick={() => setStation(null)}
          className={`min-h-[44px] px-4 rounded-xl text-sm font-bold border cursor-pointer ${
            station === null ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-300'
          }`}
        >
          All
        </button>
        {stations.map(s => (
          <button
            key={s.id}
            onClick={() => setStation(s.id)}
            className={`min-h-[44px] px-4 rounded-xl text-sm font-bold border cursor-pointer ${
              station === s.id ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-300'
            }`}
          >
            {s.name}
          </button>
        ))}

        <span className="ml-auto text-sm text-slate-500">
          {tickets.length} ticket{tickets.length === 1 ? '' : 's'}
          {tickets.length > 0 && (
            <> · oldest {formatWait(Math.floor((Date.now() - oldest) / 1000))}</>
          )}
        </span>
      </div>

      {error && (
        <div className="shrink-0 mb-3 px-4 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">
          Lost contact with the server — this board may be out of date. ({error})
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {loaded && tickets.length === 0 && (
          <p className="text-center text-slate-400 mt-16">
            Nothing to cook. New orders appear here the moment they are rung in.
          </p>
        )}

        <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3 items-start">
          {tickets.map(t => (
            <Ticket key={t.orderId} ticket={t} onBump={id => void act(id, 'bump')} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Ticket({ ticket, onBump }: { ticket: KdsTicket; onBump: (itemId: string) => void }) {
  const waited = Math.floor((Date.now() - new Date(ticket.placedAt).getTime()) / 1000);
  const level  = waited >= URGENT_S ? 'urgent' : waited >= WARN_S ? 'warn' : 'ok';

  const head = {
    ok:     'bg-slate-900 text-white',
    warn:   'bg-amber-500 text-white',
    urgent: 'bg-red-600 text-white',
  }[level];

  const edge = {
    ok:     'border-slate-300',
    warn:   'border-amber-500',
    urgent: 'border-red-600',
  }[level];

  return (
    <article className={`bg-white rounded-xl border-2 ${edge} overflow-hidden`}>
      <header className={`flex items-baseline justify-between gap-2 px-3 py-2 ${head}`}>
        <span className="text-xl font-black leading-none">#{ticket.orderNumber ?? '—'}</span>
        <span className="text-sm font-bold tabular-nums">{formatWait(waited)}</span>
      </header>

      <div className="px-3 py-1.5 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600 flex gap-2 flex-wrap">
        <span>{ticket.tableLabel ? `Table ${ticket.tableLabel}` : ticket.orderType.replace('_', ' ')}</span>
        <span className="text-slate-400">{SOURCE_LABEL[ticket.source] ?? ticket.source}</span>
      </div>

      <ul className="divide-y divide-slate-100">
        {ticket.lines.map(l => (
          <li key={l.itemId}>
            {/* The whole line is the button. A cook is tapping this with a
                knuckle or a gloved thumb, not aiming at a small target. */}
            <button
              onClick={() => onBump(l.itemId)}
              className="w-full text-left px-3 py-2.5 hover:bg-emerald-50 active:bg-emerald-100 cursor-pointer"
            >
              <div className="flex items-baseline gap-2">
                <span className="text-lg font-black tabular-nums">{l.quantity}</span>
                <span className="font-semibold leading-tight">{l.name}</span>
              </div>
              {l.modifiers.length > 0 && (
                <div className="text-xs text-slate-600 pl-6">+ {l.modifiers.join(', ')}</div>
              )}
              {/* Notes are what the customer actually asked for. Missing one
                  means the plate comes back, so it gets the loudest styling
                  on the card. */}
              {l.notes && (
                <div className="text-xs font-bold text-red-700 pl-6 mt-0.5">** {l.notes}</div>
              )}
              {l.seat && <div className="text-[11px] text-slate-400 pl-6">seat {l.seat}</div>}
            </button>
          </li>
        ))}
      </ul>

      <footer className="px-3 py-1.5 text-[11px] text-slate-400 border-t border-slate-100">
        Tap a line when it is ready
      </footer>
    </article>
  );
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
