import { useCallback, useEffect, useState } from 'react';
import { tenantFetch } from '../lib/apiClient';

// Tables, QR codes and printable cards.
//
// Replaces scripts/table-qr.ts. A restaurant owner adding table 12 on a Friday
// evening should not need a terminal, and the person who needs to reprint a
// card is the one holding it, not the one who deployed the app.

interface Table {
  id: string; area: string; label: string; seats: number;
  status: 'available' | 'occupied' | 'reserved' | 'disabled';
  qr_token?: string | null;
}

interface QrView {
  url: string;
  qrSvg: string;
  /** Only present immediately after issuing — it is stored hashed and cannot be read back. */
  pin?: string;
  hasPin?: boolean;
}

export default function SetupTables() {
  const [tables, setTables] = useState<Table[]>([]);
  const [qr,     setQr]     = useState<Record<string, QrView>>({});
  const [busy,   setBusy]   = useState<string | null>(null);
  const [error,  setError]  = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Add-table form
  const [area,   setArea]   = useState('Main');
  const [labels, setLabels] = useState('');
  const [seats,  setSeats]  = useState('4');

  const load = useCallback(async () => {
    try {
      const res = await tenantFetch('/api/pos/tables');
      if (!res.ok) throw new Error(`tables ${res.status}`);
      setTables(await res.json() as Table[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function addTables() {
    // "1,2,3" or "1-6" — a host adding a section types a range, not six forms.
    const list = expandLabels(labels);
    if (list.length === 0) { setError('Enter table names, e.g. 1,2,3 or 1-6'); return; }

    setBusy('add'); setError(null);
    let failures = 0;
    for (const label of list) {
      const res = await tenantFetch('/api/pos/tables', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ area, label, seats: Number(seats) || 4 }),
      });
      // A duplicate is not an error worth stopping for — (area,label) is unique,
      // so re-adding a range that partly exists should add only what is missing.
      if (!res.ok && res.status !== 409) failures++;
    }
    if (failures > 0) setError(`${failures} table(s) could not be added`);
    setLabels('');
    setBusy(null);
    await load();
  }

  async function showQr(tableId: string) {
    setBusy(tableId);
    try {
      const res = await tenantFetch(`/api/pos/tables/${tableId}/qr`);
      const body = await res.json() as QrView & { issued?: boolean };
      if (body.issued === false) { setQr(q => ({ ...q, [tableId]: undefined as never })); return; }
      setQr(q => ({ ...q, [tableId]: body }));
    } finally { setBusy(null); }
  }

  async function issue(tableId: string, isReissue: boolean) {
    // Re-issuing invalidates every printed card for this table. That is easy to
    // do by accident and impossible to undo, so it is confirmed.
    if (isReissue && !window.confirm(
      'Re-issuing gives this table a NEW code and PIN.\n\n' +
      'The card currently on the table will stop working and must be reprinted.\n\nContinue?',
    )) return;

    setBusy(tableId); setError(null);
    try {
      const res  = await tenantFetch(`/api/pos/tables/${tableId}/qr`, { method: 'POST' });
      const body = await res.json() as QrView & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not issue a code'); return; }
      setQr(q => ({ ...q, [tableId]: body }));
      await load();
    } finally { setBusy(null); }
  }

  async function remove(tableId: string, label: string) {
    if (!window.confirm(`Delete table ${label}?`)) return;
    setBusy(tableId);
    try {
      const res = await tenantFetch(`/api/pos/tables/${tableId}`, { method: 'DELETE' });
      if (!res.ok) setError('Could not delete — the table may have open orders');
      await load();
    } finally { setBusy(null); }
  }

  function printCards() {
    const ready = tables
      .map(t => ({ t, v: qr[t.id] }))
      .filter((x): x is { t: Table; v: QrView } => Boolean(x.v?.qrSvg));

    if (ready.length === 0) {
      setError('Show or issue a code first — only codes visible on this page can be printed.');
      return;
    }
    openPrintWindow(ready);
  }

  const areas = [...new Set(tables.map(t => t.area))].sort();

  return (
    <div className="space-y-4">
      {/* Add */}
      <section className="bg-white rounded-xl border border-slate-200 p-4">
        <h3 className="font-bold mb-1">Add tables</h3>
        <p className="text-xs text-slate-500 mb-3">
          Type a list or a range — <code>1,2,3</code> or <code>1-12</code>.
        </p>
        <div className="flex gap-2 flex-wrap items-end">
          <label className="flex-1 min-w-[8rem]">
            <span className="block text-xs font-semibold text-slate-600 mb-1">Area</span>
            <input value={area} onChange={e => setArea(e.target.value)} className={INPUT} />
          </label>
          <label className="flex-[2] min-w-[10rem]">
            <span className="block text-xs font-semibold text-slate-600 mb-1">Table names</span>
            <input
              value={labels}
              onChange={e => setLabels(e.target.value)}
              placeholder="1-12"
              className={INPUT}
            />
          </label>
          <label className="w-24">
            <span className="block text-xs font-semibold text-slate-600 mb-1">Seats</span>
            <input value={seats} onChange={e => setSeats(e.target.value)} inputMode="numeric" className={INPUT} />
          </label>
          <button
            onClick={() => void addTables()}
            disabled={busy === 'add'}
            className="min-h-[44px] px-5 rounded-xl bg-slate-900 text-white font-semibold disabled:opacity-40 cursor-pointer"
          >
            {busy === 'add' ? 'Adding…' : 'Add'}
          </button>
        </div>
      </section>

      {error && (
        <div className="px-4 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Tables */}
      {loaded && tables.length === 0 && (
        <p className="text-center text-slate-400 py-10">
          No tables yet. Add some above, then give each one a QR code.
        </p>
      )}

      {areas.map(a => (
        <section key={a}>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">{a}</h3>
            <button
              onClick={printCards}
              className="text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              Print visible cards
            </button>
          </div>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
            {tables.filter(t => t.area === a).map(t => (
              <TableCard
                key={t.id}
                table={t}
                view={qr[t.id]}
                busy={busy === t.id}
                onShow={() => void showQr(t.id)}
                onIssue={reissue => void issue(t.id, reissue)}
                onDelete={() => void remove(t.id, t.label)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function TableCard({
  table, view, busy, onShow, onIssue, onDelete,
}: {
  table: Table;
  view?: QrView;
  busy: boolean;
  onShow: () => void;
  onIssue: (reissue: boolean) => void;
  onDelete: () => void;
}) {
  const issued = Boolean(table.qr_token);

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <div className="font-bold text-lg leading-none">{table.label}</div>
          <div className="text-[11px] text-slate-500">{table.seats} seats · {table.status}</div>
        </div>
        <button
          onClick={onDelete}
          className="text-[11px] text-red-600 hover:underline cursor-pointer"
        >
          delete
        </button>
      </div>

      {view?.qrSvg && (
        <div className="mb-2">
          <div
            className="w-full max-w-[10rem] mx-auto [&>svg]:w-full [&>svg]:h-auto"
            dangerouslySetInnerHTML={{ __html: view.qrSvg }}
          />
          {view.pin && (
            <div className="mt-2 text-center">
              <div className="text-[10px] uppercase tracking-widest text-slate-400">PIN</div>
              <div className="text-2xl font-black tracking-[0.2em]">{view.pin}</div>
              {/* Said plainly, because it is true and surprising. */}
              <div className="text-[10px] text-amber-700 mt-1">
                Shown once — print or write it down now.
              </div>
            </div>
          )}
          <a
            href={view.url}
            target="_blank"
            rel="noreferrer"
            className="block mt-2 text-center text-xs font-semibold text-blue-700 hover:underline"
          >
            Open as a guest ↗
          </a>
        </div>
      )}

      <div className="flex gap-1">
        {issued && !view && (
          <Btn onClick={onShow} disabled={busy}>Show code</Btn>
        )}
        <Btn onClick={() => onIssue(issued)} disabled={busy} primary={!issued}>
          {busy ? '…' : issued ? 'New code' : 'Create code'}
        </Btn>
      </div>
    </div>
  );
}

// ── Printing ─────────────────────────────────────────────────────────────────

/**
 * Open a print window with one A6 card per table.
 *
 * A new window rather than a print stylesheet on this page: the admin screen has
 * navigation, forms and buttons that nobody wants on a laminated table card, and
 * hiding them all with CSS is more fragile than starting from a blank document.
 */
function openPrintWindow(cards: Array<{ t: { label: string; area: string }; v: { qrSvg: string; pin?: string } }>): void {
  const w = window.open('', '_blank', 'width=800,height=900');
  if (!w) return;

  const esc = (s: string) => s.replace(/[&<>"]/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

  w.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Table cards</title>
<style>
  @page { size: A6; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { width: 105mm; height: 148mm; padding: 10mm; display: flex; flex-direction: column;
          align-items: center; justify-content: center; text-align: center;
          page-break-after: always; }
  .area  { font-size: 10pt; letter-spacing: .18em; text-transform: uppercase; color: #777; }
  .label { font-size: 34pt; font-weight: 800; line-height: 1; margin: 2mm 0 4mm; }
  .qr    { width: 55mm; height: 55mm; }
  .qr svg { width: 100%; height: 100%; }
  .lead  { font-size: 10pt; color: #444; margin-top: 4mm; }
  .pinbox { margin-top: 3mm; padding: 3mm 6mm; border: 2px solid #111; border-radius: 3mm; }
  .pinlabel { font-size: 8pt; letter-spacing: .18em; text-transform: uppercase; color: #777; }
  .pin   { font-size: 24pt; font-weight: 800; letter-spacing: .3em; }
  .nopin { font-size: 8pt; color: #b45309; margin-top: 3mm; }
  @media screen { body { background: #eee; padding: 10mm; }
                  .card { background: #fff; margin: 0 auto 8mm; box-shadow: 0 2px 8px rgba(0,0,0,.15); } }
</style></head><body>
${cards.map(({ t, v }) => `<div class="card">
  <div class="area">${esc(t.area)}</div>
  <div class="label">${esc(t.label)}</div>
  <div class="qr">${v.qrSvg}</div>
  <div class="lead">Scan to see the menu and order</div>
  ${v.pin
    ? `<div class="pinbox"><div class="pinlabel">PIN</div><div class="pin">${esc(v.pin)}</div></div>`
    : `<div class="nopin">PIN not shown — press “New code” to print a card with one.</div>`}
</div>`).join('')}
</body></html>`);

  w.document.close();
  // Let the SVGs lay out before the print dialog measures the page.
  setTimeout(() => w.print(), 300);
}

// ── bits ─────────────────────────────────────────────────────────────────────

const INPUT = 'w-full min-h-[44px] px-3 rounded-lg border border-slate-300';

function Btn({ children, onClick, disabled, primary }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 min-h-[40px] rounded-lg text-xs font-semibold border disabled:opacity-40 cursor-pointer ${
        primary ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-300 hover:bg-slate-50'
      }`}
    >
      {children}
    </button>
  );
}

/** "1,2,3" or "1-6" or "A1,A2" → a list of table names. */
export function expandLabels(input: string): string[] {
  const out: string[] = [];
  for (const part of input.split(',').map(s => s.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      // Guard the count, not just the direction: "1-9999" is a typo, not a
      // request for nine thousand tables.
      if (b >= a && b - a < 200) {
        for (let i = a; i <= b; i++) out.push(String(i));
        continue;
      }
    }
    out.push(part);
  }
  return [...new Set(out)];
}
