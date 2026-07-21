import { useState } from 'react';
import type { EndpointParams, DiscoveredField, ProbeResult } from './lib/posPresets';

// ─────────────────────────────────────────────────────────────────────────────
// "Detect requirements" for one endpoint. Probes the POS endpoint (OpenAPI import
// or live error-shape inference) and pops the required params/filters as input
// fields the onboarder fills in. Values are stored as EndpointParams the adapter
// injects on every call.
// ─────────────────────────────────────────────────────────────────────────────

type ParamLoc = 'query' | 'body' | 'header';
// EndpointParams uses 'headers'; a discovered field uses 'header'. Bridge them.
const groupKey = (loc: ParamLoc): keyof EndpointParams => (loc === 'header' ? 'headers' : loc);

interface Props {
  label:    string;
  method:   string;
  path:     string;
  baseUrl:  string;
  apiKey?:  string;
  jwtToken: string;
  params:   EndpointParams | undefined;
  onChange: (params: EndpointParams) => void;
}

export default function EndpointDiscovery({ label, method, path, baseUrl, apiKey, jwtToken, params, onChange }: Props) {
  const [busy,       setBusy]       = useState(false);
  const [result,     setResult]     = useState<ProbeResult | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredField[]>([]);

  const getVal = (loc: ParamLoc, name: string) => params?.[groupKey(loc)]?.[name] ?? '';
  const setVal = (loc: ParamLoc, name: string, value: string) => {
    const key   = groupKey(loc);
    const next  = { ...(params ?? {}) };
    const group = { ...(next[key] ?? {}) };
    if (value === '') delete group[name]; else group[name] = value;
    next[key] = Object.keys(group).length ? group : undefined;
    onChange(next);
  };

  const detect = async () => {
    if (!baseUrl) { setResult({ ok: false, source: 'none', authRequired: false, fields: [], message: 'Enter the backend URL first.' }); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/admin/probe-endpoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwtToken}` },
        body: JSON.stringify({ baseUrl, path, method, apiKey: apiKey || undefined }),
      });
      const body = await r.json() as ProbeResult & { error?: string };
      if (!r.ok) { setResult({ ok: false, source: 'none', authRequired: false, fields: [], message: body.error ?? 'Probe failed' }); return; }
      setResult(body);
      setDiscovered(body.fields ?? []);
      // Seed empty entries so each discovered field renders an input immediately.
      const next = { ...(params ?? {}) };
      for (const f of body.fields ?? []) {
        const key = groupKey(f.in);
        next[key] = { ...(next[key] ?? {}) };
        if (!(f.name in (next[key] as Record<string, string>))) (next[key] as Record<string, string>)[f.name] = '';
      }
      onChange(next);
    } catch {
      setResult({ ok: false, source: 'none', authRequired: false, fields: [], message: 'Network error' });
    } finally {
      setBusy(false);
    }
  };

  // Combine discovered fields with any params already saved, so both are editable.
  const rows: { name: string; loc: ParamLoc; required?: boolean; description?: string; example?: string }[] = [];
  const seen = new Set<string>();
  for (const f of discovered) { rows.push({ name: f.name, loc: f.in, required: f.required, description: f.description, example: f.example }); seen.add(`${f.in}:${f.name}`); }
  (['query', 'body', 'header'] as ParamLoc[]).forEach(loc => {
    const grp = params?.[groupKey(loc)] ?? {};
    for (const name of Object.keys(grp)) if (!seen.has(`${loc}:${name}`)) rows.push({ name, loc });
  });

  return (
    <div className="flex flex-col gap-2 mt-1">
      <button
        type="button" onClick={detect} disabled={busy}
        className="self-start px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest border border-[#5A5A40]/30 text-[#5A5A40] hover:border-[#5A5A40]/60 transition disabled:opacity-50 cursor-pointer"
      >
        {busy ? 'Detecting…' : `🔍 Detect requirements — ${label}`}
      </button>

      {result && (
        <p className={`text-[10px] leading-snug ${result.ok ? 'opacity-50' : 'text-red-600'}`}>
          {result.source === 'openapi' && '✓ From API spec. '}
          {result.source === 'probe'   && '✓ From live probe. '}
          {result.message}
        </p>
      )}

      {rows.length > 0 && (
        <div className="flex flex-col gap-2 bg-[#5A5A40]/4 rounded-lg p-2.5">
          {rows.map(row => (
            <div key={`${row.loc}:${row.name}`} className="flex items-start gap-2">
              <div className="w-36 shrink-0 pt-2">
                <span className="text-[11px] font-mono text-[#5A5A40] opacity-80">{row.name}</span>
                <span className="ml-1 text-[8px] uppercase tracking-widest opacity-40">{row.loc}</span>
                {row.required && <span className="text-red-500 text-[10px]"> *</span>}
              </div>
              <div className="flex-1">
                <input
                  value={getVal(row.loc, row.name)}
                  onChange={e => setVal(row.loc, row.name, e.target.value)}
                  placeholder={row.example ? `e.g. ${row.example}` : `value for ${row.name}`}
                  className="w-full text-xs bg-white/80 border border-[#5A5A40]/15 rounded-lg px-2 py-1.5 placeholder:opacity-25 focus:outline-none font-mono"
                />
                {row.description && <p className="text-[9px] opacity-40 mt-0.5 leading-snug">{row.description}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
