import { useCallback, useEffect, useMemo, useState } from 'react';
import { tenantFetch } from '../lib/apiClient';

// Bookings and the waitlist.
//
// A thin layer over routes/reservations.ts, which already owns every rule that
// matters — lead time, party size, double-booking. None of that is re-checked
// here: the same endpoints serve the voice agent and any future public booking
// page, so a rule enforced in this component would be a rule those two do not
// have. The UI's job is to make the server's answers legible.

interface Reservation {
  id:           string;
  guest_name:   string;
  guest_phone:  string | null;
  party_size:   number;
  starts_at:    string;
  duration_min: number;
  status:       'booked' | 'confirmed' | 'seated' | 'completed' | 'no_show' | 'cancelled';
  source:       string;
  notes:        string | null;
  tableIds:     string[];
}

interface WaitlistEntry {
  id:              string;
  name:            string;
  phone:           string | null;
  party_size:      number;
  quoted_wait_min: number | null;
  status:          'waiting' | 'notified' | 'seated' | 'left' | 'cancelled';
  created_at:      string;
}

interface VenueTable { id: string; label: string; area: string; seats: number }

const STATUS_STYLE: Record<Reservation['status'], string> = {
  booked:    'bg-slate-100 text-slate-700',
  confirmed: 'bg-blue-100 text-blue-800',
  seated:    'bg-emerald-100 text-emerald-800',
  completed: 'bg-slate-100 text-slate-400',
  no_show:   'bg-red-100 text-red-800',
  cancelled: 'bg-slate-100 text-slate-400',
};

// Local date, not UTC. `toISOString().slice(0,10)` silently shifts the day for
// anyone east of Greenwich after 5pm — which is exactly when a restaurant is
// booking its evening service.
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function Reservations() {
  const [date,     setDate]     = useState(todayLocal());
  const [list,     setList]     = useState<Reservation[]>([]);
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [tables,   setTables]   = useState<VenueTable[]>([]);
  const [tab,      setTab]      = useState<'bookings' | 'waitlist'>('bookings');
  const [adding,   setAdding]   = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [loaded,   setLoaded]   = useState(false);

  const load = useCallback(async () => {
    try {
      // The day in LOCAL time, sent as an instant. The server stores timestamptz
      // so the boundaries have to be real moments, not a bare date.
      const from = new Date(`${date}T00:00:00`).toISOString();
      const to   = new Date(`${date}T23:59:59`).toISOString();

      const [rRes, wRes, tRes] = await Promise.all([
        tenantFetch(`/api/reservations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
        tenantFetch('/api/reservations/waitlist'),
        tenantFetch('/api/reservations/tables'),
      ]);

      if (!rRes.ok) throw new Error(`bookings ${rRes.status}`);
      setList(await rRes.json() as Reservation[]);
      if (wRes.ok) setWaitlist(await wRes.json() as WaitlistEntry[]);
      if (tRes.ok) setTables(await tRes.json() as VenueTable[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, [date]);

  useEffect(() => { void load(); }, [load]);

  const tableLabel = useMemo(() => new Map(tables.map(t => [t.id, t.label])), [tables]);

  // Sorted by time, and cancellations pushed to the bottom: a host scanning the
  // list wants the next arrival at the top, not a booking that is not coming.
  const sorted = useMemo(() => [...list].sort((a, b) => {
    const dead = (s: Reservation['status']) => s === 'cancelled' || s === 'no_show' ? 1 : 0;
    return dead(a.status) - dead(b.status)
      || new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
  }), [list]);

  async function setStatus(id: string, status: string) {
    setError(null);
    const res = await tenantFetch(`/api/reservations/${id}/status`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({})) as { error?: string };
      setError(b.error ?? `Could not update (${res.status})`);
    }
    await load();
  }

  async function seat(id: string, tableIds: string[]) {
    setError(null);
    const res = await tenantFetch(`/api/reservations/${id}/seat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tableIds }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({})) as { error?: string };
      setError(b.error ?? 'Could not seat this booking');
    }
    await load();
  }

  const waiting = waitlist.filter(w => w.status === 'waiting' || w.status === 'notified');

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 flex items-center gap-2 mb-3 flex-wrap">
        {(['bookings', 'waitlist'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`min-h-[44px] px-4 rounded-xl text-sm font-bold border capitalize cursor-pointer ${
              tab === t ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-300'
            }`}
          >
            {t}
            {t === 'waitlist' && waiting.length > 0 && (
              <span className="ml-2 text-xs bg-amber-500 text-white rounded-full px-2 py-0.5">
                {waiting.length}
              </span>
            )}
          </button>
        ))}

        {tab === 'bookings' && (
          <>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="min-h-[44px] px-3 rounded-xl border border-slate-300"
            />
            <button
              onClick={() => setAdding(true)}
              className="min-h-[44px] px-4 rounded-xl bg-slate-900 text-white text-sm font-bold cursor-pointer"
            >
              New booking
            </button>
          </>
        )}
        {tab === 'waitlist' && (
          <button
            onClick={() => setAdding(true)}
            className="min-h-[44px] px-4 rounded-xl bg-slate-900 text-white text-sm font-bold cursor-pointer"
          >
            Add to waitlist
          </button>
        )}
      </div>

      {error && (
        <div className="shrink-0 mb-3 px-4 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {!loaded && <p className="text-slate-500">Loading…</p>}

        {loaded && tab === 'bookings' && (
          sorted.length === 0
            ? <Empty title="No bookings for this day" body="Use “New booking” to take one, or pick another date." />
            : (
              <ul className="space-y-2">
                {sorted.map(r => (
                  <BookingRow
                    key={r.id}
                    r={r}
                    tables={tables}
                    tableLabel={tableLabel}
                    onStatus={setStatus}
                    onSeat={seat}
                  />
                ))}
              </ul>
            )
        )}

        {loaded && tab === 'waitlist' && (
          waiting.length === 0
            ? <Empty title="Nobody waiting" body="Walk-ins you cannot seat immediately go here." />
            : (
              <ul className="space-y-2">
                {waiting.map(w => <WaitRow key={w.id} w={w} onChanged={load} onError={setError} />)}
              </ul>
            )
        )}
      </div>

      {adding && (
        <AddDialog
          kind={tab}
          date={date}
          onClose={() => setAdding(false)}
          onDone={async () => { setAdding(false); await load(); }}
        />
      )}
    </div>
  );
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function BookingRow({
  r, tables, tableLabel, onStatus, onSeat,
}: {
  r: Reservation;
  tables: VenueTable[];
  tableLabel: Map<string, string>;
  onStatus: (id: string, status: string) => Promise<void>;
  onSeat: (id: string, tableIds: string[]) => Promise<void>;
}) {
  const [picking, setPicking] = useState(false);
  const time = new Date(r.starts_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const done = r.status === 'completed' || r.status === 'cancelled' || r.status === 'no_show';

  return (
    <li className={`bg-white rounded-xl border border-slate-200 p-3 ${done ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3 flex-wrap">
        <div className="w-16 shrink-0">
          <div className="text-lg font-bold tabular-nums leading-none">{time}</div>
          <div className="text-[11px] text-slate-500">{r.duration_min}m</div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold truncate">{r.guest_name}</span>
            <span className="text-sm text-slate-500">party of {r.party_size}</span>
            <span className={`text-[10px] font-bold uppercase tracking-wider rounded-md px-2 py-0.5 ${STATUS_STYLE[r.status]}`}>
              {r.status.replace('_', ' ')}
            </span>
            {r.source !== 'staff' && (
              <span className="text-[10px] text-slate-400 uppercase">{r.source}</span>
            )}
          </div>
          {r.guest_phone && <div className="text-xs text-slate-500">{r.guest_phone}</div>}
          {r.tableIds.length > 0 && (
            <div className="text-xs text-slate-600">
              Table {r.tableIds.map(id => tableLabel.get(id) ?? '?').join(', ')}
            </div>
          )}
          {r.notes && <div className="text-xs text-slate-500 italic">{r.notes}</div>}
        </div>

        {!done && (
          <div className="flex gap-1 shrink-0 flex-wrap">
            {r.status === 'booked' && (
              <Small onClick={() => void onStatus(r.id, 'confirmed')}>Confirm</Small>
            )}
            {r.status !== 'seated' && (
              <Small primary onClick={() => setPicking(p => !p)}>Seat</Small>
            )}
            {r.status === 'seated' && (
              <Small onClick={() => void onStatus(r.id, 'completed')}>Done</Small>
            )}
            {/* No-show is kept distinct from cancelled on purpose: one is the
                guest's decision communicated in advance, the other is a table
                held empty through a service. They are different problems. */}
            <Small onClick={() => void onStatus(r.id, 'no_show')}>No-show</Small>
            <Small onClick={() => void onStatus(r.id, 'cancelled')}>Cancel</Small>
          </div>
        )}
      </div>

      {picking && (
        <div className="mt-3 pt-3 border-t border-slate-100">
          <p className="text-xs font-semibold text-slate-600 mb-2">
            Which table? The server refuses a table that is already booked for this time.
          </p>
          <div className="flex gap-2 flex-wrap">
            {tables.map(t => (
              <button
                key={t.id}
                onClick={() => { setPicking(false); void onSeat(r.id, [t.id]); }}
                className="min-h-[40px] px-3 rounded-lg border border-slate-300 text-sm hover:bg-slate-50 cursor-pointer"
              >
                {t.label}
                <span className="text-[11px] text-slate-400 ml-1">{t.seats}p</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}

function WaitRow({
  w, onChanged, onError,
}: {
  w: WaitlistEntry;
  onChanged: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const waited = Math.floor((Date.now() - new Date(w.created_at).getTime()) / 60000);
  const over   = w.quoted_wait_min !== null && waited > w.quoted_wait_min;

  async function set(status: string) {
    const res = await tenantFetch(`/api/reservations/waitlist/${w.id}/status`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status }),
    });
    if (!res.ok) onError(`Could not update (${res.status})`);
    await onChanged();
  }

  return (
    <li className={`bg-white rounded-xl border p-3 flex items-center gap-3 flex-wrap ${
      over ? 'border-red-300' : 'border-slate-200'
    }`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold truncate">{w.name}</span>
          <span className="text-sm text-slate-500">party of {w.party_size}</span>
          {w.status === 'notified' && (
            <span className="text-[10px] font-bold uppercase bg-blue-100 text-blue-800 rounded-md px-2 py-0.5">
              notified
            </span>
          )}
        </div>
        <div className={`text-xs ${over ? 'text-red-700 font-semibold' : 'text-slate-500'}`}>
          waiting {waited}m
          {w.quoted_wait_min !== null && ` · quoted ${w.quoted_wait_min}m`}
          {/* Being past the quote is the number that matters — it is the moment
              a guest starts feeling lied to. */}
          {over && ' · over the quote'}
        </div>
        {w.phone && <div className="text-xs text-slate-500">{w.phone}</div>}
      </div>

      <div className="flex gap-1 shrink-0">
        {w.status === 'waiting' && <Small onClick={() => void set('notified')}>Notify</Small>}
        <Small primary onClick={() => void set('seated')}>Seat</Small>
        <Small onClick={() => void set('left')}>Left</Small>
      </div>
    </li>
  );
}

// ── Add dialog ───────────────────────────────────────────────────────────────

function AddDialog({
  kind, date, onClose, onDone,
}: {
  kind: 'bookings' | 'waitlist';
  date: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [name,  setName]  = useState('');
  const [phone, setPhone] = useState('');
  const [party, setParty] = useState('2');
  const [time,  setTime]  = useState('19:00');
  const [wait,  setWait]  = useState('15');
  const [notes, setNotes] = useState('');
  const [busy,  setBusy]  = useState(false);
  const [err,   setErr]   = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const isBooking = kind === 'bookings';
      const url  = isBooking ? '/api/reservations' : '/api/reservations/waitlist';
      const body = isBooking
        ? {
            guestName:  name,
            guestPhone: phone || null,
            partySize:  Number(party) || 1,
            // Built from the local date and time the host typed. Constructing
            // it as UTC would move an evening booking to the wrong day.
            startsAt:   new Date(`${date}T${time}:00`).toISOString(),
            notes:      notes || null,
            source:     'staff' as const,
          }
        : {
            name,
            phone:        phone || null,
            partySize:    Number(party) || 1,
            quotedWaitMin: Number(wait) || null,
            notes:        notes || null,
          };

      const res = await tenantFetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });

      if (!res.ok) {
        // The server owns lead time, party size and double-booking. Show what
        // it said rather than paraphrasing — the message names the actual rule.
        const b = await res.json().catch(() => ({})) as { error?: string };
        setErr(b.error ?? `Could not save (${res.status})`);
        return;
      }
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white w-full max-w-sm rounded-2xl p-4">
        <h2 className="font-bold mb-3">
          {kind === 'bookings' ? 'New booking' : 'Add to waitlist'}
        </h2>

        <Field label="Guest name">
          <input value={name} onChange={e => setName(e.target.value)} className={INPUT} />
        </Field>
        <Field label="Phone (optional)">
          <input value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" className={INPUT} />
        </Field>
        <Field label="Party size">
          <input value={party} onChange={e => setParty(e.target.value)} inputMode="numeric" className={INPUT} />
        </Field>

        {kind === 'bookings' ? (
          <Field label={`Time on ${date}`}>
            <input type="time" value={time} onChange={e => setTime(e.target.value)} className={INPUT} />
          </Field>
        ) : (
          <Field label="Quoted wait (minutes)">
            <input value={wait} onChange={e => setWait(e.target.value)} inputMode="numeric" className={INPUT} />
          </Field>
        )}

        <Field label="Notes (optional)">
          <input value={notes} onChange={e => setNotes(e.target.value)} className={INPUT} />
        </Field>

        {err && <p className="text-sm text-red-700 mb-2">{err}</p>}

        <div className="flex gap-2 mt-2">
          <button onClick={onClose} className="flex-1 min-h-[48px] rounded-xl border border-slate-300 font-semibold cursor-pointer">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
            className="flex-1 min-h-[48px] rounded-xl bg-slate-900 text-white font-semibold disabled:opacity-40 cursor-pointer"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── bits ─────────────────────────────────────────────────────────────────────

const INPUT = 'w-full min-h-[44px] px-3 rounded-lg border border-slate-300';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block mb-3">
      <span className="block text-xs font-semibold text-slate-600 mb-1">{label}</span>
      {children}
    </label>
  );
}

function Small({ children, onClick, primary }: {
  children: React.ReactNode; onClick: () => void; primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`min-h-[40px] px-3 rounded-lg text-xs font-semibold border cursor-pointer ${
        primary ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-300 hover:bg-slate-50'
      }`}
    >
      {children}
    </button>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="max-w-md mx-auto mt-12 text-center">
      <h2 className="font-bold text-slate-800 mb-1">{title}</h2>
      <p className="text-sm text-slate-500">{body}</p>
    </div>
  );
}
