import { useState, useEffect, useId } from 'react';

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

type Tab = 'overview' | 'config' | 'menu' | 'connection' | 'usage' | 'audit';

interface MenuCategoryRow { id: string; name: string; sortOrder: number }
interface MenuItemRow     { id: string; categoryId: string; name: string; description: string; price: number; available: boolean }
interface MenuData        { categories: MenuCategoryRow[]; items: MenuItemRow[] }

interface UsageDay {
  date:           string;
  promptTokens:   number;
  responseTokens: number;
  callCount:      number;
  costUsd:        number;
}

interface AuditEntry {
  ts:       string;
  action:   string;
  sub:      string;
  tenantId: string;
  details?: string;
}

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
  const [usageData,   setUsageData]   = useState<UsageDay[]>([]);
  const [auditData,   setAuditData]   = useState<AuditEntry[]>([]);
  const [usageLoading,  setUsageLoading]  = useState(false);
  const [auditLoading,  setAuditLoading]  = useState(false);
  // Credentials (custom_api only) — apiKey is write-only, never returned from server
  const [credBaseUrl,   setCredBaseUrl]   = useState('');
  const [credApiKey,    setCredApiKey]    = useState('');
  const [credSaving,    setCredSaving]    = useState(false);
  const [credMsg,       setCredMsg]       = useState('');
  const [credHas,       setCredHas]       = useState(false);
  // Menu management
  const [menuData,      setMenuData]      = useState<MenuData>({ categories: [], items: [] });
  const [menuLoaded,    setMenuLoaded]    = useState(false);
  const [menuLoading,   setMenuLoading]   = useState(false);
  const [menuSaving,    setMenuSaving]    = useState(false);
  const [menuMsg,       setMenuMsg]       = useState('');
  const [syncBusy,      setSyncBusy]      = useState(false);
  const [syncMsg,       setSyncMsg]       = useState('');
  const menuUid = useId();

  const authHeaders = { Authorization: `Bearer ${jwtToken}`, 'Content-Type': 'application/json' };

  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);

  const playVoicePreview = async (voice: string) => {
    if (previewingVoice) return;
    setPreviewingVoice(voice);
    try {
      const r = await fetch('/api/admin/preview-voice', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ voice }),
      });
      if (!r.ok) { setPreviewingVoice(null); return; }
      const { audioBase64, mimeType } = await r.json() as { audioBase64: string; mimeType: string };
      const binary = atob(audioBase64);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const int16   = new Int16Array(bytes.buffer);
      const float32 = Float32Array.from(int16, s => s / 32768);
      const rate    = parseInt(mimeType.match(/rate=(\d+)/)?.[1] ?? '24000');
      const ctx     = new AudioContext({ sampleRate: rate });
      const buf     = ctx.createBuffer(1, float32.length, rate);
      buf.copyToChannel(float32, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
      src.onended = () => { ctx.close(); setPreviewingVoice(null); };
    } catch {
      setPreviewingVoice(null);
    }
  };

  const addCategory = () => {
    const id = `${menuUid}-cat-${Date.now()}`;
    setMenuData(prev => ({
      ...prev,
      categories: [...prev.categories, { id, name: '', sortOrder: prev.categories.length }],
    }));
  };
  const removeCategory = (catId: string) =>
    setMenuData(prev => ({
      categories: prev.categories.filter(c => c.id !== catId),
      items:      prev.items.filter(i => i.categoryId !== catId),
    }));
  const updateCategory = (catId: string, patch: Partial<MenuCategoryRow>) =>
    setMenuData(prev => ({ ...prev, categories: prev.categories.map(c => c.id === catId ? { ...c, ...patch } : c) }));
  const addItem = (catId: string) => {
    const id = `${menuUid}-item-${Date.now()}`;
    setMenuData(prev => ({
      ...prev,
      items: [...prev.items, { id, categoryId: catId, name: '', description: '', price: 0, available: true }],
    }));
  };
  const removeItem = (itemId: string) =>
    setMenuData(prev => ({ ...prev, items: prev.items.filter(i => i.id !== itemId) }));
  const updateItem = (itemId: string, patch: Partial<MenuItemRow>) =>
    setMenuData(prev => ({ ...prev, items: prev.items.map(i => i.id === itemId ? { ...i, ...patch } : i) }));

  const handleSaveMenu = async () => {
    setMenuSaving(true);
    setMenuMsg('');
    setSyncMsg('');
    try {
      const r = await fetch('/api/admin/menu', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(menuData),
      });
      const body = await r.json() as { ok?: boolean; error?: string; syncOk?: boolean; syncError?: string };
      if (r.ok && body.ok) {
        if (body.syncOk === false) {
          setMenuMsg('Saved to menu.');
          setSyncMsg('AI sync failed — click "Sync to AI" to retry so voice ordering works');
        } else {
          setMenuMsg('Saved!');
        }
      } else {
        setMenuMsg(body.error ?? 'Save failed');
      }
    } catch {
      setMenuMsg('Network error');
    } finally {
      setMenuSaving(false);
      setTimeout(() => setMenuMsg(m => m === 'Saved!' ? '' : m), 3000);
    }
  };

  const handleSyncToBackend = async () => {
    setSyncBusy(true);
    setSyncMsg('');
    try {
      const r = await fetch('/api/admin/menu/sync', {
        method: 'POST',
        headers: authHeaders,
      });
      const body = await r.json() as { ok?: boolean; error?: string };
      setSyncMsg(r.ok && body.ok ? 'Synced! AI can now find your items.' : (body.error ?? 'Sync failed'));
    } catch {
      setSyncMsg('Network error');
    } finally {
      setSyncBusy(false);
      setTimeout(() => setSyncMsg(m => m.startsWith('Synced') ? '' : m), 5000);
    }
  };

  useEffect(() => {
    const authH = { Authorization: `Bearer ${jwtToken}` };
    Promise.all([
      fetch('/api/admin/my-config',          { headers: authH }).then(r => r.json() as Promise<FullConfig>),
      fetch('/api/admin/credentials-status', { headers: authH }).then(r => r.json() as Promise<{ hasCredentials: boolean; baseUrl?: string }>),
    ])
      .then(([cfg, creds]) => {
        setConfig(cfg); setDraft(cfg); setTestUrl('');
        setCredHas(creds.hasCredentials);
        if (creds.baseUrl) setCredBaseUrl(creds.baseUrl);
      })
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
      if (config?.adapter.type === 'managed') {
        // Managed tenants — test through the platform proxy, no URL needed
        const r = await fetch('/api/agent/menu-context', { headers: { Authorization: `Bearer ${jwtToken}` } });
        if (r.ok) {
          const text = await r.text();
          setTestResult({ ok: true, msg: text.slice(0, 400) || '(empty menu context — backend reachable)' });
        } else {
          setTestResult({ ok: false, msg: `HTTP ${r.status} — managed backend unreachable` });
        }
      } else {
        const r = await fetch('/api/admin/test-connection', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ backendUrl: testUrl }),
        });
        const body = await r.json() as { ok: boolean; sampleOutput?: string; error?: string };
        setTestResult({ ok: body.ok, msg: body.ok ? (body.sampleOutput ?? 'Connected!') : (body.error ?? 'Error') });
      }
    } catch (err) {
      setTestResult({ ok: false, msg: String(err) });
    } finally {
      setTestBusy(false);
    }
  };

  const handleSaveCredentials = async () => {
    if (!credBaseUrl) return;
    setCredSaving(true);
    setCredMsg('');
    try {
      const r = await fetch('/api/admin/save-credentials', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ baseUrl: credBaseUrl, apiKey: credApiKey || undefined }),
      });
      const body = await r.json() as { ok?: boolean; error?: string };
      if (r.ok && body.ok) { setCredHas(true); setCredApiKey(''); setCredMsg('Saved!'); }
      else { setCredMsg(body.error ?? 'Save failed'); }
    } catch {
      setCredMsg('Network error');
    } finally {
      setCredSaving(false);
      setTimeout(() => setCredMsg(''), 3000);
    }
  };

  const handleTabChange = (t: Tab) => {
    setTab(t);
    if (t === 'usage' && usageData.length === 0) {
      setUsageLoading(true);
      fetch('/api/admin/usage?days=7', { headers: { Authorization: `Bearer ${jwtToken}` } })
        .then(r => r.json() as Promise<UsageDay[]>)
        .then(d => setUsageData(Array.isArray(d) ? d : []))
        .catch(() => undefined)
        .finally(() => setUsageLoading(false));
    }
    if (t === 'audit' && auditData.length === 0) {
      setAuditLoading(true);
      fetch('/api/admin/audit-log', { headers: { Authorization: `Bearer ${jwtToken}` } })
        .then(r => r.json() as Promise<AuditEntry[]>)
        .then(d => setAuditData(Array.isArray(d) ? d : []))
        .catch(() => undefined)
        .finally(() => setAuditLoading(false));
    }
    if (t === 'menu' && !menuLoaded) {
      setMenuLoading(true);
      fetch('/api/admin/menu', { headers: { Authorization: `Bearer ${jwtToken}` } })
        .then(r => r.json() as Promise<MenuData>)
        .then(d => { setMenuData(d); setMenuLoaded(true); })
        .catch(() => undefined)
        .finally(() => setMenuLoading(false));
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
      <nav className="shrink-0 flex gap-0 border-b border-[#5A5A40]/10 px-5 bg-white/30 overflow-x-auto">
        {(['overview', 'config', 'menu', 'usage', 'audit', 'connection'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => handleTabChange(t)}
            className={`shrink-0 px-4 py-3 text-xs font-semibold uppercase tracking-widest transition border-b-2 cursor-pointer ${
              tab === t
                ? 'border-[#5A5A40] text-[#5A5A40]'
                : 'border-transparent text-[#5A5A40] opacity-40 hover:opacity-70'
            }`}
          >
            {t === 'overview' ? 'Overview'
              : t === 'config' ? 'Configuration'
              : t === 'menu'   ? 'Menu'
              : t === 'usage'  ? 'Usage'
              : t === 'audit'  ? 'Audit Log'
              : 'Connection Test'}
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
              <Field label="Voice" hint="Click to select · ▶ to preview">
                <div className="flex flex-wrap gap-2">
                  {VOICES.map(v => (
                    <div key={v} className="relative group">
                      <button type="button"
                        onClick={() => patchDraft('gemini', { voice: v })}
                        className={`pl-3 pr-7 py-1.5 rounded-full text-xs font-semibold border transition cursor-pointer ${
                          draft.gemini.voice === v
                            ? 'bg-[#5A5A40] text-[#F8F7F2] border-[#5A5A40]'
                            : 'border-[#5A5A40]/20 text-[#5A5A40] hover:border-[#5A5A40]/50'
                        }`}
                      >{v}</button>
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); playVoicePreview(v); }}
                        disabled={previewingVoice !== null}
                        title="Preview voice"
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] opacity-50 hover:opacity-100 disabled:opacity-20 cursor-pointer transition"
                      >
                        {previewingVoice === v ? '…' : '▶'}
                      </button>
                    </div>
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

            {/* API Credentials — only shown for custom_api adapter */}
            {draft.adapter.type === 'custom_api' && (
              <Section title="API Credentials">
                <p className="text-xs opacity-50 leading-relaxed -mt-1">
                  Credentials are encrypted with AES-256 and never appear in logs or exports.
                  {credHas ? ' You have saved credentials — enter a new key to rotate it.' : ''}
                </p>
                <Field label="Backend Base URL">
                  <input value={credBaseUrl} onChange={e => setCredBaseUrl(e.target.value)}
                    className={INPUT} placeholder="https://api.myrestaurant.com" />
                </Field>
                <Field label="API Key" hint={credHas ? 'Leave blank to keep existing key' : ''}>
                  <input type="password" value={credApiKey} onChange={e => setCredApiKey(e.target.value)}
                    className={INPUT} placeholder={credHas ? '••••••••' : 'sk-…'} />
                </Field>
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleSaveCredentials} disabled={credSaving || !credBaseUrl}
                    className="px-5 py-2.5 bg-[#5A5A40] text-[#F8F7F2] rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-[#4a4a33] transition disabled:opacity-50 cursor-pointer"
                  >
                    {credSaving ? 'Saving…' : 'Save Credentials'}
                  </button>
                  {credMsg && (
                    <span className={`text-sm font-semibold ${credMsg === 'Saved!' ? 'text-green-600' : 'text-red-600'}`}>
                      {credMsg}
                    </span>
                  )}
                </div>
              </Section>
            )}

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

        {/* Menu */}
        {tab === 'menu' && (
          <div className="flex flex-col gap-4">
            {config?.adapter.type === 'custom_api' ? (
              <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
                <p className="text-sm font-bold text-blue-800 mb-1">Menu comes from your API</p>
                <p className="text-xs text-blue-700 leading-relaxed">
                  For Custom API adapters, the menu is fetched directly from your backend.
                  To update menu items, update your backend service.
                </p>
              </div>
            ) : menuLoading ? (
              <p className="text-sm opacity-40 text-center py-8">Loading…</p>
            ) : (
              <>
                <p className="text-sm opacity-60 leading-relaxed">
                  Manage your menu categories and items. Changes take effect immediately — Gemini will use the updated menu on the next voice session.
                </p>

                {menuData.categories.map(cat => (
                  <div key={cat.id} className="bg-white/60 border border-[#5A5A40]/10 rounded-2xl p-4 flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <input
                        value={cat.name}
                        onChange={e => updateCategory(cat.id, { name: e.target.value })}
                        className={INPUT + ' font-bold'}
                        placeholder="Category name (e.g. Main Course)"
                      />
                      <button type="button" onClick={() => removeCategory(cat.id)}
                        className="text-red-400 hover:text-red-600 text-xs px-2 shrink-0 cursor-pointer">✕</button>
                    </div>

                    {menuData.items.filter(i => i.categoryId === cat.id).length > 0 && (
                      <div className="grid grid-cols-[1fr_1fr_72px_40px_auto] gap-2 items-center px-1 py-1">
                        {['Name','Description','Price','Avail.',''].map(h => (
                          <span key={h} className="text-[10px] uppercase tracking-widest opacity-35 font-semibold">{h}</span>
                        ))}
                      </div>
                    )}

                    {menuData.items.filter(i => i.categoryId === cat.id).map(item => (
                      <div key={item.id} className="grid grid-cols-[1fr_1fr_72px_40px_auto] gap-2 items-center">
                        <input value={item.name}
                          onChange={e => updateItem(item.id, { name: e.target.value })}
                          className={INPUT} placeholder="Item name" />
                        <input value={item.description}
                          onChange={e => updateItem(item.id, { description: e.target.value })}
                          className={INPUT} placeholder="Description" />
                        <input type="number" min="0" step="0.01" value={item.price}
                          onChange={e => updateItem(item.id, { price: Number(e.target.value) })}
                          className={INPUT} placeholder="0.00" />
                        <button
                          type="button"
                          onClick={() => updateItem(item.id, { available: !item.available })}
                          title={item.available ? 'Mark unavailable' : 'Mark available'}
                          className={`relative w-8 h-4 rounded-full transition cursor-pointer shrink-0 ${item.available ? 'bg-[#5A5A40]' : 'bg-[#5A5A40]/20'}`}
                        >
                          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${item.available ? 'translate-x-4' : 'translate-x-0.5'}`} />
                        </button>
                        <button type="button" onClick={() => removeItem(item.id)}
                          className="text-red-400 hover:text-red-600 text-xs px-2 cursor-pointer">✕</button>
                      </div>
                    ))}

                    <button type="button" onClick={() => addItem(cat.id)}
                      className="self-start text-xs text-[#5A5A40] opacity-50 hover:opacity-90 mt-1 cursor-pointer">
                      + Add item
                    </button>
                  </div>
                ))}

                <button type="button" onClick={addCategory}
                  className="self-start px-4 py-2 border border-[#5A5A40]/20 rounded-xl text-sm text-[#5A5A40] hover:border-[#5A5A40]/50 transition cursor-pointer">
                  + Add category
                </button>

                <div className="flex flex-col gap-2 sticky bottom-3">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSaveMenu} disabled={menuSaving || syncBusy}
                      className="flex-1 py-3 bg-[#5A5A40] text-[#F8F7F2] rounded-2xl font-bold text-sm uppercase tracking-widest hover:bg-[#4a4a33] active:scale-[0.98] transition disabled:opacity-50 cursor-pointer"
                    >
                      {menuSaving ? 'Saving…' : 'Save Menu'}
                    </button>
                    <button
                      onClick={handleSyncToBackend} disabled={syncBusy || menuSaving}
                      title="Push menu to AI backend so voice ordering can find your items"
                      className="shrink-0 px-4 py-3 border border-[#5A5A40]/30 rounded-2xl font-bold text-xs uppercase tracking-widest text-[#5A5A40] hover:border-[#5A5A40]/60 active:scale-[0.98] transition disabled:opacity-50 cursor-pointer"
                    >
                      {syncBusy ? 'Syncing…' : 'Sync to AI'}
                    </button>
                  </div>
                  {menuMsg && (
                    <span className={`text-sm font-semibold ${menuMsg === 'Saved!' || menuMsg === 'Saved to menu.' ? 'text-green-600' : 'text-red-600'}`}>
                      {menuMsg}
                    </span>
                  )}
                  {syncMsg && (
                    <span className={`text-sm font-semibold ${syncMsg.startsWith('Synced') ? 'text-green-600' : 'text-red-600'}`}>
                      {syncMsg}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* Usage */}
        {tab === 'usage' && (
          <div className="flex flex-col gap-4">
            <p className="text-sm opacity-60 leading-relaxed">
              AI token usage and estimated cost for the last 7 days. Cost is estimated using Gemini Live pricing at time of last update.
            </p>
            {usageLoading ? (
              <p className="text-sm opacity-40 text-center py-8">Loading…</p>
            ) : usageData.length === 0 ? (
              <p className="text-sm opacity-40 text-center py-8">No usage data yet — usage is recorded after voice turns complete.</p>
            ) : (
              <>
                {/* Summary cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: 'Total Calls',    value: usageData.reduce((s, d) => s + d.callCount,      0).toLocaleString() },
                    { label: 'Prompt Tokens',  value: usageData.reduce((s, d) => s + d.promptTokens,   0).toLocaleString() },
                    { label: 'Output Tokens',  value: usageData.reduce((s, d) => s + d.responseTokens, 0).toLocaleString() },
                    { label: 'Est. Cost (USD)', value: `$${usageData.reduce((s, d) => s + d.costUsd, 0).toFixed(4)}` },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-white/60 border border-white/80 rounded-2xl p-4 text-center">
                      <p className="text-[10px] uppercase tracking-widest opacity-40 font-semibold">{label}</p>
                      <p className="font-bold text-[#5A5A40] mt-1 text-sm">{value}</p>
                    </div>
                  ))}
                </div>
                {/* Day-by-day table */}
                <div className="bg-white/60 border border-white/80 rounded-2xl overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-[#5A5A40]/10">
                        {['Date','Calls','Prompt','Output','Est. Cost'].map(h => (
                          <th key={h} className="px-4 py-3 text-left font-semibold uppercase tracking-widest opacity-40">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {usageData.map(d => (
                        <tr key={d.date} className="border-b border-[#5A5A40]/5 last:border-0 hover:bg-[#5A5A40]/3">
                          <td className="px-4 py-3 font-mono opacity-70">{d.date}</td>
                          <td className="px-4 py-3">{d.callCount}</td>
                          <td className="px-4 py-3">{d.promptTokens.toLocaleString()}</td>
                          <td className="px-4 py-3">{d.responseTokens.toLocaleString()}</td>
                          <td className="px-4 py-3 font-mono">${d.costUsd.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {/* Audit Log */}
        {tab === 'audit' && (
          <div className="flex flex-col gap-4">
            <p className="text-sm opacity-60 leading-relaxed">
              Last 50 actions recorded for this tenant — logins, registrations, and config changes.
            </p>
            {auditLoading ? (
              <p className="text-sm opacity-40 text-center py-8">Loading…</p>
            ) : auditData.length === 0 ? (
              <p className="text-sm opacity-40 text-center py-8">No audit log entries yet.</p>
            ) : (
              <div className="bg-white/60 border border-white/80 rounded-2xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[#5A5A40]/10">
                      {['Time','Action','User','Details'].map(h => (
                        <th key={h} className="px-4 py-3 text-left font-semibold uppercase tracking-widest opacity-40">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {auditData.map((e, i) => (
                      <tr key={i} className="border-b border-[#5A5A40]/5 last:border-0 hover:bg-[#5A5A40]/3">
                        <td className="px-4 py-3 font-mono opacity-60 whitespace-nowrap">
                          {new Date(e.ts).toLocaleString()}
                        </td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded-full bg-[#5A5A40]/8 font-semibold uppercase tracking-widest text-[10px]">
                            {e.action}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono opacity-60 max-w-[160px] truncate">{e.sub}</td>
                        <td className="px-4 py-3 opacity-50">{e.details ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Connection Test */}
        {tab === 'connection' && (
          <div className="flex flex-col gap-4">
            {config?.adapter.type === 'managed' ? (
              <div className="bg-[#5A5A40]/5 border border-[#5A5A40]/10 rounded-2xl p-4 text-sm">
                <p className="font-semibold text-[#5A5A40]">Managed Backend</p>
                <p className="opacity-60 mt-1 leading-relaxed">
                  Your backend is managed by the platform — no URL configuration needed.
                  Click below to verify the connection through the proxy.
                </p>
              </div>
            ) : (
              <>
                <p className="text-sm opacity-60 leading-relaxed">
                  Test connectivity to your custom backend. The request will include your <code className="font-mono bg-[#5A5A40]/8 px-1 rounded">Authorization</code> header.
                </p>
                <Field label="Backend Base URL">
                  <input value={testUrl} onChange={e => setTestUrl(e.target.value)}
                    className={INPUT} placeholder="https://api.myrestaurant.com" />
                </Field>
              </>
            )}
            <button
              onClick={handleTest}
              disabled={testBusy || (config?.adapter.type !== 'managed' && !testUrl)}
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

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] uppercase tracking-widest opacity-50 font-semibold">{label}</label>
      {children}
      {hint && <p className="text-[10px] opacity-40">{hint}</p>}
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
