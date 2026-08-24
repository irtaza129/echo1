import { useEffect, useRef, useState } from 'react';
import { tenantFetch } from '../lib/apiClient';

// "Table 6 is calling."
//
// This is the destination for the guest app's Call Waiter button and the reason
// the realtime spine exists: a diner presses a button and someone carrying
// plates needs to know within seconds, not on the next poll.
//
// It renders as a banner above everything else on the terminal rather than a
// tab, because an alert nobody is looking at is not an alert.

export interface ServiceRequest {
  id:         string;
  tableId:    string;
  tableLabel: string;
  area:       string;
  type:       'call_waiter' | 'request_bill' | 'water' | 'assistance';
  note:       string | null;
  status:     string;
  createdAt:  string;
}

const LABEL: Record<ServiceRequest['type'], string> = {
  call_waiter:  'Calling a waiter',
  request_bill: 'Asking for the bill',
  water:        'Asking for water',
  assistance:   'Needs help',
};

export default function ServiceAlerts({
  requests, staffId, onChanged, muted, onToggleMute,
}: {
  requests: ServiceRequest[];
  staffId:  string;
  onChanged: () => void;
  muted:    boolean;
  onToggleMute: () => void;
}) {
  // Re-render once a second so the "waiting Xm" figure stays honest without
  // refetching anything.
  const [, tick] = useState(0);
  useEffect(() => {
    if (requests.length === 0) return;
    const id = setInterval(() => tick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [requests.length]);

  // Chime on a genuinely new request, never on a re-render or a refetch.
  const seen = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh = requests.filter(r => !seen.current.has(r.id));
    for (const r of requests) seen.current.add(r.id);
    if (fresh.length > 0 && !muted) chime();
  }, [requests, muted]);

  if (requests.length === 0) return null;

  return (
    <div className="shrink-0 bg-amber-50 border-b-2 border-amber-300">
      <div className="flex items-center justify-between gap-3 px-4 py-1.5">
        <span className="text-xs font-bold uppercase tracking-widest text-amber-900">
          {requests.length} table{requests.length > 1 ? 's' : ''} waiting
        </span>
        <button
          onClick={onToggleMute}
          className="text-xs font-semibold text-amber-800 hover:text-amber-950 cursor-pointer"
        >
          {muted ? 'Unmute' : 'Mute'}
        </button>
      </div>

      <ul className="flex gap-2 overflow-x-auto px-4 pb-2">
        {requests.map(r => (
          <li key={r.id}>
            <AlertCard request={r} staffId={staffId} onChanged={onChanged} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function AlertCard({
  request, staffId, onChanged,
}: {
  request: ServiceRequest; staffId: string; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const waited = Math.floor((Date.now() - new Date(request.createdAt).getTime()) / 1000);

  // Colour by age, not by type. A table waiting four minutes matters more than
  // what they asked for.
  const urgent = waited > 180;

  async function act(action: 'acknowledge' | 'resolve') {
    setBusy(true);
    try {
      await tenantFetch(`/api/pos/service-requests/${request.id}/${action}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ staffId }),
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`shrink-0 w-56 rounded-xl border-2 p-2.5 bg-white ${
      urgent ? 'border-red-400' : 'border-amber-300'
    }`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-bold">Table {request.tableLabel}</span>
        <span className={`text-xs tabular-nums ${urgent ? 'text-red-700 font-bold' : 'text-slate-500'}`}>
          {formatWait(waited)}
        </span>
      </div>
      <p className="text-xs text-slate-600">{LABEL[request.type]}</p>
      {request.note && <p className="text-xs text-slate-500 italic truncate">{request.note}</p>}

      <div className="flex gap-1 mt-2">
        {request.status === 'open' && (
          <button
            onClick={() => void act('acknowledge')}
            disabled={busy}
            className="flex-1 min-h-[36px] rounded-lg border border-slate-300 text-xs font-semibold disabled:opacity-50 cursor-pointer"
          >
            On my way
          </button>
        )}
        <button
          onClick={() => void act('resolve')}
          disabled={busy}
          className="flex-1 min-h-[36px] rounded-lg bg-slate-900 text-white text-xs font-semibold disabled:opacity-50 cursor-pointer"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m ${seconds % 60}s`;
}

// A short two-tone beep via WebAudio. No audio file to ship, no autoplay policy
// to fight beyond the first user gesture — and by the time this fires, a
// cashier has already tapped a PIN, so the context is unlocked.
function chime(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;

    for (const [i, freq] of [880, 1174].entries()) {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // Ramp rather than switch: an abrupt gain change clicks audibly.
      gain.gain.setValueAtTime(0.0001, now + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.18);
      osc.stop(now + i * 0.18 + 0.18);
    }

    // Release the hardware once the sound has finished.
    setTimeout(() => void ctx.close().catch(() => undefined), 800);
  } catch {
    // Audio is a nicety; the visual banner is the actual alert.
  }
}
