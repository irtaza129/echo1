import { useState, useEffect } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FullConfig {
  tenantId:       string;
  slug:           string;
  restaurantName: string;
  plan:           string;
  adapter:        { type: string };
  gemini: {
    agentName:          string;
    voice:              string;
    languages:          string[];
    systemPromptExtras: string;
  };
  branding: {
    primaryColor: string;
    logoUrl:      string;
    kioskTitle:   string;
  };
  businessRules: {
    gstRate:            number;
    currencySymbol:     string;
    orderStatusMachine: string[];
  };
  features: {
    deliveryOrders:   boolean;
    tableNumbers:     boolean;
    transcriptScreen: boolean;
    loyaltyPoints:    boolean;
  };
}

interface Props {
  jwtToken:            string;
  onLogout:            () => void;
  onNavigateToKiosk:   () => void;
  onNavigateToDashboard: () => void;
}

type Tab = 'overview' | 'config' | 'connection';

const VOICES = ['Puck','Zephyr','Charon','Kore','Fenrir','Aoede','Orbit','Umbriel','Algieba'];
const LANGUAGE_OPTIONS = [
  { code: 'en', label: 'English' }, { code: 'ur', label: 'Urdu' },
  { code: 'roman-ur', label: 'Roman Urdu' }, { code: 'ar', label: 'Arabic' },
  { code: 'es', label: 'Spanish' },  { code: 'fr', label: 'French' },
];

// ── Component ─────────────────────────────────────────────────────────────────

export default function AdminDashboard({ jwtToken, onLogout, onNavigateToKiosk, onNavigateToDashboard }: Props) {
  const [tab,         setTab]         = useState<Tab>('overview');
  const [config,      setConfig]      = useState<FullConfig | null>(null);
  const [draft,       setDraft]       = useState<FullConfig | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [saveMsg,     setSaveMsg]     = useState('');
  const [testUrl,     setTestUrl]     = useState('');
  const [testResult,  setTestResult]  = useState<{ ok: boolean; msg: string } | null>(null);
  const [testBusy,    setTestBusy]    = useState(false);
  const [copied,      setCopied]      = useState(false);

  const authHeaders = { Authorization: `Bearer ${jwtToken}`, 'Content-Type': 'application/json' };

  useEffect(() => {
    fetch('/api/admin/my-config', { headers: { Authorization: `Bearer ${jwtToken}` } })
      .then(r => r.json() as Promise<FullConfig>)
      .then(cfg => { setConfig(cfg); setDraft(cfg); setTestUrl(''); })
      .catch(() => setSaveMsg('Failed to load config'))
      .finally(() => setLoading(false));
  }, [jwtToken]);

  const patchDraft = <K extends keyof FullConfig>(section: K, updates: Partial<FullConfig[K]>) =>
    setDraft(prev => prev ? { ...prev, [section]: { ...(prev[section] as object), ...updates } } : prev);

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveMsg('');
    try {
      const r = await fetch('/api/admin/save-config', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(draft),
      });
      const body = await r.json() as { ok?: boolean; error?: string };
      if (r.ok && body.ok) {
        setConfig(draft);
        setSaveMsg('Saved!');
      } else {
        setSaveMsg(body.error ?? 'Save failed');
      }
    } catch {
      setSaveMsg('Network error');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(''), 3000);
    }
  };

  const handleTest = async () => {
    setTestBusy(true);
    setTestResult(null);
    try {
      const r = await fetch('/api/admin/test-connection', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ backendUrl: testUrl }),
      });
      const body = await r.json() as { ok: boolean; sampleOutput?: string; error?: string };
      setTestResult({ ok: body.ok, msg: body.ok ? (body.sampleOutput ?? 'Connected!') : (body.error ?? 'Error') });
    } catch (err) {
      setTestResult({ ok: false, msg: String(err) });
    } finally {
      setTestBusy(false);
    }
  };

  const copyKioskUrl = () => {
    const url = `${window.location.origin}/kiosk/${config?.slug}`;
    navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[#F8F7F2]">
        <p className="text-sm opacity-40">Loading…</p>
      </div>
    );
  }

  const kioskUrl = `${window.location.origin}/kiosk/${config?.slug ?? ''}`;

  return (
    <div className="flex flex-col h-full bg-[#F8F7F2] overflow-hidden">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-[#5A5A40]/10 bg-white/50">
        <div>
          <h1 className="font-serif font-bold text-[#5A5A40] text-lg leading-tight">
            {config?.restaurantName ?? 'Admin'}
          </h1>
          <p className="text-[10px] uppercase tracking-widest opacity-40 mt-0.5">
            Tenant Admin · {config?.plan ?? ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onNavigateToDashboard}
            className="px-3 py-2 text-xs font-semibold text-[#5A5A40] border border-[#5A5A40]/20 rounded-xl hover:border-[#5A5A40]/50 transition cursor-pointer"
          >
            Orders
          </button>
          <button
            onClick={onNavigateToKiosk}
            className="px-3 py-2 text-xs font-semibold text-[#5A5A40] border border-[#5A5A40]/20 rounded-xl hover:border-[#5A5A40]/50 transition cursor-pointer"
          >
            Kiosk
          </button>
          <button
            onClick={onLogout}
            className="px-3 py-2 text-xs font-semibold text-red-600 border border-red-200 rounded-xl hover:bg-red-50 transition cursor-pointer"
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* ── Tabs ────────────────────────────────────────────────────────────── */}
      <nav className="shrink-0 flex gap-0 border-b border-[#5A5A40]/10 px-5 bg-white/30">
        {(['overview', 'config', 'connection'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-3 text-xs font-semibold uppercase tracking-widest transition border-b-2 cursor-pointer ${
              tab === t
                ? 'border-[#5A5A40] text-[#5A5A40]'
                : 'border-transparent text-[#5A5A40] opacity-40 hover:opacity-70'
            }`}
          >
            {t === 'overview' ? 'Overview' : t === 'config' ? 'Configuration' : 'Connection Test'}
          </button>
        ))}
      </nav>

      {/* ── Content ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-5 max-w-3xl mx-auto w-full">

        {/* Overview */}
        {tab === 'overview' && config && (
          <div className="flex flex-col gap-5">
            <div className="bg-white/60 border border-white/80 rounded-2xl p-5">
              <p className="text-[10px] uppercase tracking-widest opacity-40 font-semibold mb-3">Kiosk URL</p>
              <div className="flex items-center gap-3 bg-[#F8F7F2] rounded-xl px-4 py-3 border border-[#5A5A40]/10">
                <span className="flex-1 text-sm font-mono text-[#5A5A40] break-all">{kioskUrl}</span>
                <button
                  onClick={copyKioskUrl}
                  className="shrink-0 text-xs font-semibold text-[#5A5A40] px-3 py-1.5 rounded-lg border border-[#5A5A40]/20 hover:border-[#5A5A40]/50 transition cursor-pointer"
                >
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
              </div>
              <button
                onClick={onNavigateToKiosk}
                className="mt-3 w-full py-2.5 bg-[#5A5A40] text-[#F8F7F2] rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-[#4a4a33] transition cursor-pointer"
              >
                Open Kiosk →
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {([
                { label: 'Adapter',   value: config.adapter.type },
                { label: 'AI Voice',  value: config.gemini.voice },
                { label: 'Languages', value: config.gemini.languages.length.toString() },
                { label: 'Plan',      value: config.plan },
              ]).map(({ label, value }) => (
                <div key={label} className="bg-white/60 border border-white/80 rounded-2xl p-4 text-center">
                  <p className="text-[10px] uppercase tracking-widest opacity-40 font-semibold">{label}</p>
                  <p className="font-bold text-[#5A5A40] mt-1 capitalize">{value}</p>
                </div>
              ))}
            </div>

            <div className="bg-white/60 border border-white/80 rounded-2xl p-5">
              <p className="text-[10px] uppercase tracking-widest opacity-40 font-semibold mb-3">Features</p>
              <div className="grid grid-cols-2 gap-y-2 gap-x-4">
                {Object.entries(config.features).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2 text-sm">
                    <span className={`w-2 h-2 rounded-full ${v ? 'bg-green-500' : 'bg-[#5A5A40]/20'}`} />
                    <span className="capitalize opacity-70">
                      {k.replace(/([A-Z])/g, ' $1').trim()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Configuration */}
        {tab === 'config' && draft && (
          <div className="flex flex-col gap-5">

            {/* Branding */}
            <Section title="Branding">
              <Field label="Restaurant Name">
                <input value={draft.restaurantName}
                  onChange={e => setDraft(p => p ? { ...p, restaurantName: e.target.value } : p)}
                  className={INPUT} />
              </Field>
              <Field label="Kiosk Title">
                <input value={draft.branding.kioskTitle}
                  onChange={e => patchDraft('branding', { kioskTitle: e.target.value })}
                  className={INPUT} />
              </Field>
              <Field label="Logo URL">
                <input value={draft.branding.logoUrl}
                  onChange={e => patchDraft('branding', { logoUrl: e.target.value })}
                  className={INPUT} placeholder="https://…/logo.png" />
              </Field>
              <div className="flex gap-4 items-end">
                <Field label="Brand Colour">
                  <div className="flex items-center gap-3">
                    <input type="color" value={draft.branding.primaryColor}
                      onChange={e => patchDraft('branding', { primaryColor: e.target.value })}
                      className="w-10 h-10 rounded-lg border border-[#5A5A40]/15 cursor-pointer" />
                    <span className="text-sm font-mono opacity-60">{draft.branding.primaryColor}</span>
                  </div>
                </Field>
                <Field label="Currency">
                  <input value={draft.businessRules.currencySymbol}
                    onChange={e => patchDraft('businessRules', { currencySymbol: e.target.value })}
                    className={INPUT + ' max-w-[72px]'} maxLength={4} />
                </Field>
              </div>
            </Section>

            {/* AI Persona */}
            <Section title="AI Persona">
              <Field label="Agent Name">
                <input value={draft.gemini.agentName}
                  onChange={e => patchDraft('gemini', { agentName: e.target.value })}
                  className={INPUT} />
              </Field>
              <Field label="Voice">
                <div className="flex flex-wrap gap-2">
                  {VOICES.map(v => (
                    <button key={v} type="button"
                      onClick={() => patchDraft('gemini', { voice: v })}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition cursor-pointer ${
                        draft.gemini.voice === v
                          ? 'bg-[#5A5A40] text-[#F8F7F2] border-[#5A5A40]'
                          : 'border-[#5A5A40]/20 text-[#5A5A40] hover:border-[#5A5A40]/50'
                      }`}
                    >{v}</button>
                  ))}
                </div>
              </Field>
              <Field label="Languages">
                <div className="flex flex-wrap gap-2">
                  {LANGUAGE_OPTIONS.map(l => {
                    const on = draft.gemini.languages.includes(l.code);
                    return (
                      <button key={l.code} type="button"
                        onClick={() => patchDraft('gemini', {
                          languages: on
                            ? draft.gemini.languages.filter(x => x !== l.code)
                            : [...draft.gemini.languages, l.code],
                        })}
                        className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition cursor-pointer ${
                          on ? 'bg-[#5A5A40] text-[#F8F7F2] border-[#5A5A40]'
                             : 'border-[#5A5A40]/20 text-[#5A5A40] hover:border-[#5A5A40]/50'
                        }`}
                      >{l.label}</button>
                    );
                  })}
                </div>
              </Field>
              <Field label="Extra Instructions">
                <textarea rows={6} value={draft.gemini.systemPromptExtras}
                  onChange={e => patchDraft('gemini', { systemPromptExtras: e.target.value })}
                  className={INPUT + ' resize-none'} />
              </Field>
            </Section>

            {/* Business Rules */}
            <Section title="Business Rules">
              <Field label="GST / Tax Rate (%)">
                <input type="number" min="0" max="100" step="0.1"
                  value={draft.businessRules.gstRate * 100}
                  onChange={e => patchDraft('businessRules', { gstRate: Number(e.target.value) / 100 })}
                  className={INPUT + ' max-w-[100px]'} />
              </Field>

              <p className="text-[11px] uppercase tracking-widest opacity-40 font-semibold mt-2">Features</p>
              {([
                { key: 'deliveryOrders',   label: 'Delivery Orders' },
                { key: 'tableNumbers',     label: 'Table Numbers' },
                { key: 'transcriptScreen', label: 'Transcript Screen' },
                { key: 'loyaltyPoints',    label: 'Loyalty Points' },
              ] as const).map(f => (
                <label key={f.key} className="flex items-center justify-between cursor-pointer">
                  <span className="text-sm font-semibold text-[#5A5A40]">{f.label}</span>
                  <button
                    type="button"
                    onClick={() => patchDraft('features', { [f.key]: !draft.features[f.key] })}
                    className={`relative w-10 h-5 rounded-full transition cursor-pointer ${
                      draft.features[f.key] ? 'bg-[#5A5A40]' : 'bg-[#5A5A40]/20'
                    }`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                      draft.features[f.key] ? 'translate-x-5' : 'translate-x-0.5'
                    }`} />
                  </button>
                </label>
              ))}
            </Section>

            {/* Save bar */}
            <div className="flex items-center gap-3 sticky bottom-3">
              <button
                onClick={handleSave} disabled={saving}
                className="flex-1 py-3 bg-[#5A5A40] text-[#F8F7F2] rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-[#4a4a33] active:scale-[0.98] transition disabled:opacity-50 cursor-pointer"
              >
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
              {saveMsg && (
                <span className={`text-sm font-semibold ${saveMsg === 'Saved!' ? 'text-green-600' : 'text-red-600'}`}>
                  {saveMsg}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Connection Test */}
        {tab === 'connection' && (
          <div className="flex flex-col gap-4">
            <p className="text-sm opacity-60 leading-relaxed">
              Test connectivity to a backend API endpoint. The request will include your <code className="font-mono bg-[#5A5A40]/8 px-1 rounded">X-Tenant-ID</code> header.
            </p>
            <Field label="Backend Base URL">
              <input value={testUrl} onChange={e => setTestUrl(e.target.value)}
                className={INPUT} placeholder="https://voiceai-hzyb.onrender.com" />
            </Field>
            <button
              onClick={handleTest} disabled={testBusy || !testUrl}
              className="self-start px-6 py-3 bg-[#5A5A40] text-[#F8F7F2] rounded-xl font-bold text-sm uppercase tracking-widest hover:bg-[#4a4a33] active:scale-95 transition disabled:opacity-50 cursor-pointer"
            >
              {testBusy ? 'Testing…' : 'Test Connection'}
            </button>
            {testResult && (
              <div className={`rounded-2xl p-4 border text-sm ${
                testResult.ok
                  ? 'bg-green-50 border-green-200 text-green-800'
                  : 'bg-red-50   border-red-200   text-red-700'
              }`}>
                <p className="font-bold mb-1">{testResult.ok ? '✓ Connected' : '✗ Failed'}</p>
                <pre className="whitespace-pre-wrap font-mono text-xs opacity-80 max-h-60 overflow-y-auto">{testResult.msg}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Shared primitives ─────────────────────────────────────────────────────────

const INPUT = 'w-full bg-white/80 border border-[#5A5A40]/15 rounded-xl px-4 py-3 text-sm text-[#3D3D33] placeholder:opacity-30 focus:outline-none focus:ring-2 focus:ring-[#5A5A40]/25 transition';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] uppercase tracking-widest opacity-50 font-semibold">{label}</label>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white/60 border border-white/80 rounded-2xl p-5 flex flex-col gap-4">
      <p className="text-[10px] uppercase tracking-widest opacity-40 font-semibold -mb-1">{title}</p>
      {children}
    </div>
  );
}
