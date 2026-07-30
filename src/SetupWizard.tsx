import { useState, useId, useEffect } from 'react';
import {
  POS_PRESETS, getPreset, defaultEndpointMappings,
  ENDPOINT_OPERATIONS, RESOLVE_ITEM_MAP_FIELDS,
  type EndpointMapping, type PresetAdapterType,
} from './lib/posPresets';
import EndpointDiscovery from './EndpointDiscovery';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MenuCategoryRow { id: string; name: string; sortOrder: number }
interface MenuItemRow     { id: string; categoryId: string; name: string; description: string; price: number; available: boolean }
interface MenuData        { categories: MenuCategoryRow[]; items: MenuItemRow[] }

interface WizardConfig {
  restaurantName: string;
  slug:           string;
  plan:           string;
  adapter: {
    presetId:         string;
    type:             PresetAdapterType;
    backendUrl:       string;
    apiKey:           string;
    webhookUrl:       string;
    endpointMappings: EndpointMappingDraft[];
  };
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
    gstRate:        number;
    currencySymbol: string;
  };
  features: {
    deliveryOrders:   boolean;
    tableNumbers:     boolean;
    transcriptScreen: boolean;
    loyaltyPoints:    boolean;
  };
}

type EndpointMappingDraft = EndpointMapping;

interface Props {
  jwtToken:         string;
  initialSlug:      string;
  initialName:      string;
  initialConfig?:   Record<string, any>;
  initialStep?:     number;
  onComplete:       () => void;
  onExit:           () => void;
  onLogout:         () => void;
}

const VOICES = ['Puck','Zephyr','Charon','Kore','Fenrir','Aoede','Orbit','Umbriel','Algieba'];
const LANGUAGE_OPTIONS = [
  { code: 'en',       label: 'English' },
  { code: 'ur',       label: 'Urdu' },
  { code: 'roman-ur', label: 'Roman Urdu' },
  { code: 'ar',       label: 'Arabic' },
  { code: 'es',       label: 'Spanish' },
  { code: 'fr',       label: 'French' },
];

const STEPS = [
  'Restaurant',
  'Plan',
  'Adapter',
  'Test',
  'Menu',
  'AI Persona',
  'Rules',
  'Launch',
] as const;

const PLANS = [
  {
    id:    'starter' as const,
    name:  'Starter',
    price: 'Free',
    desc:  'Perfect for a single-location restaurant getting started with voice ordering.',
    features: ['1 kiosk URL', 'Managed backend', 'Basic AI persona', 'Email support'],
  },
  {
    id:    'growth' as const,
    name:  'Growth',
    price: '$49 / mo',
    desc:  'For growing restaurants that need custom branding and multi-language support.',
    features: ['3 kiosk URLs', 'Custom API adapter', 'All AI persona options', 'Transcript screen', 'Priority support'],
  },
  {
    id:    'enterprise' as const,
    name:  'Enterprise',
    price: 'Contact us',
    desc:  'Full platform access for chains, franchises, and enterprise deployments.',
    features: ['Unlimited kiosks', 'Webhook adapter', 'White-label branding', 'Dedicated support', 'SLA guarantee'],
  },
] as const;

// ── Component ─────────────────────────────────────────────────────────────────

export default function SetupWizard({ jwtToken, initialSlug, initialName, initialConfig, initialStep = 0, onComplete, onExit, onLogout }: Props) {
  const [step,  setStep]  = useState(initialStep);
  const [error, setError] = useState('');
  const [busy,  setBusy]  = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  const [cfg, setCfg] = useState<WizardConfig>({
    restaurantName: initialConfig?.restaurantName ?? initialName,
    slug:           initialConfig?.slug ?? initialSlug,
    plan:           initialConfig?.plan ?? 'starter',
    adapter: initialConfig?.adapter ?? {
      presetId:         'managed',
      type:             'managed',
      backendUrl:       '',
      apiKey:           '',
      webhookUrl:       '',
      endpointMappings: defaultEndpointMappings(),
    },
    gemini: initialConfig?.gemini ?? {
      agentName:          `${initialName} Assistant`,
      voice:              'Puck',
      languages:          ['en'],
      systemPromptExtras: '',
    },
    branding: initialConfig?.branding ?? {
      primaryColor: '#5A5A40',
      logoUrl:      '',
      kioskTitle:   `Welcome to ${initialName}`,
    },
    businessRules: initialConfig?.businessRules ?? { gstRate: 0, currencySymbol: '$' },
    features: initialConfig?.features ?? { deliveryOrders: false, tableNumbers: false, transcriptScreen: false, loyaltyPoints: false },
  });

  const [testResult,    setTestResult]    = useState<{ ok: boolean; msg: string } | null>(null);
  const [showEpConfig,  setShowEpConfig]  = useState(false);
  const [showFieldMap,  setShowFieldMap]  = useState(false);
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);

  // Load saved config and resume from last step on mount
  useEffect(() => {
    if (!initialConfig) return;

    // Pre-populate cfg with all saved data from initialConfig
    const savedStep = initialConfig.setupStep ?? 0;
    setCfg(prev => ({
      ...prev,
      restaurantName: initialConfig.restaurantName ?? prev.restaurantName,
      slug: initialConfig.slug ?? prev.slug,
      plan: initialConfig.plan ?? prev.plan,
      adapter: initialConfig.adapter ?? prev.adapter,
      gemini: initialConfig.gemini ?? prev.gemini,
      branding: initialConfig.branding ?? prev.branding,
      businessRules: initialConfig.businessRules ?? prev.businessRules,
      features: initialConfig.features ?? prev.features,
    }));

    // Jump to saved step
    setStep(savedStep);
  }, []);

  const patchMapping = (opKey: string, updates: Partial<EndpointMappingDraft>) =>
    setCfg(prev => ({
      ...prev,
      adapter: {
        ...prev.adapter,
        endpointMappings: prev.adapter.endpointMappings.map(m =>
          m.operation === opKey ? { ...m, ...updates } : m
        ),
      },
    }));

  const setFieldMapping = (opKey: string, ourField: string, theirPath: string) =>
    setCfg(prev => {
      const m = prev.adapter.endpointMappings.find(x => x.operation === opKey);
      const fm = { ...(m?.fieldMappings ?? {}), [ourField]: theirPath };
      if (!theirPath) delete fm[ourField];
      return {
        ...prev,
        adapter: {
          ...prev.adapter,
          endpointMappings: prev.adapter.endpointMappings.map(x =>
            x.operation === opKey ? { ...x, fieldMappings: fm } : x
          ),
        },
      };
    });

  const playVoicePreview = async (voice: string) => {
    if (previewingVoice) return;
    setPreviewingVoice(voice);
    try {
      const r = await fetch('/api/admin/preview-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwtToken}` },
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
  const [menuData,   setMenuData]   = useState<MenuData>({ categories: [], items: [] });
  const uid = useId();

  const addCategory = () => {
    const id = `${uid}-cat-${Date.now()}`;
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
    const id = `${uid}-item-${Date.now()}`;
    setMenuData(prev => ({
      ...prev,
      items: [...prev.items, { id, categoryId: catId, name: '', description: '', price: 0, available: true }],
    }));
  };
  const removeItem = (itemId: string) =>
    setMenuData(prev => ({ ...prev, items: prev.items.filter(i => i.id !== itemId) }));
  const updateItem = (itemId: string, patch: Partial<MenuItemRow>) =>
    setMenuData(prev => ({ ...prev, items: prev.items.map(i => i.id === itemId ? { ...i, ...patch } : i) }));

  const patch = <K extends keyof WizardConfig>(section: K, updates: Partial<WizardConfig[K]>) =>
    setCfg(prev => ({ ...prev, [section]: { ...(prev[section] as object), ...updates } }));

  const selectPreset = (presetId: string) =>
    setCfg(prev => {
      const preset = getPreset(presetId);
      if (!preset) return prev;
      return {
        ...prev,
        adapter: {
          ...prev.adapter,
          presetId,
          type:             preset.adapterType,
          endpointMappings: preset.endpointMappings ?? defaultEndpointMappings(),
        },
      };
    });

  const runTest = async () => {
    setBusy(true);
    setTestResult(null);
    setError('');
    try {
      if (cfg.adapter.type !== 'custom_api') {
        const r = await fetch('/api/agent/menu-context');
        if (r.ok) {
          const text = await r.text();
          setTestResult({ ok: true, msg: text.slice(0, 300) || '(empty menu context)' });
        } else {
          setTestResult({ ok: false, msg: `HTTP ${r.status}` });
        }
      } else {
        const r = await fetch('/api/admin/test-connection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwtToken}` },
          body: JSON.stringify({
            backendUrl:       cfg.adapter.backendUrl,
            apiKey:           cfg.adapter.apiKey || undefined,
            endpointMappings: cfg.adapter.endpointMappings,
          }),
        });
        const body = await r.json() as { ok: boolean; sampleOutput?: string; error?: string };
        setTestResult({ ok: body.ok, msg: body.ok ? (body.sampleOutput ?? 'Connected!') : (body.error ?? 'Unknown error') });
      }
    } catch (err) {
      setTestResult({ ok: false, msg: String(err) });
    } finally {
      setBusy(false);
    }
  };

  const saveAndLaunch = async () => {
    setBusy(true);
    setError('');
    try {
      const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${jwtToken}` };

      const needsCreds =
        (cfg.adapter.type === 'custom_api' && cfg.adapter.backendUrl) ||
        (cfg.adapter.type === 'webhook'    && cfg.adapter.webhookUrl);
      if (needsCreds) {
        const cr = await fetch('/api/admin/save-credentials', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            baseUrl:    cfg.adapter.backendUrl || undefined,
            apiKey:     cfg.adapter.apiKey     || undefined,
            webhookUrl: cfg.adapter.webhookUrl || undefined,
          }),
        });
        const crBody = await cr.json() as { ok?: boolean; error?: string };
        if (!cr.ok || !crBody.ok) { setError(crBody.error ?? 'Failed to save credentials'); return; }
      }

      const payload = {
        restaurantName: cfg.restaurantName,
        slug:           cfg.slug,
        plan:           cfg.plan,
        adapter: {
          type:             cfg.adapter.type,
          endpointMappings: cfg.adapter.type === 'custom_api' ? cfg.adapter.endpointMappings : undefined,
        },
        gemini:         cfg.gemini,
        branding:       cfg.branding,
        businessRules: {
          gstRate:            cfg.businessRules.gstRate,
          currencySymbol:     cfg.businessRules.currencySymbol,
          orderStatusMachine: ['pending','confirmed','preparing','ready','delivered'],
        },
        features: cfg.features,
        setupComplete: true,
        setupStep: STEPS.length - 1,
      };
      const r = await fetch('/api/admin/save-config', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(payload),
      });
      const body = await r.json() as { ok?: boolean; kioskUrl?: string; error?: string };
      if (!r.ok || !body.ok) { setError(body.error ?? 'Save failed'); return; }

      if (cfg.adapter.type !== 'custom_api' && menuData.categories.length > 0) {
        await fetch('/api/admin/menu', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(menuData),
        }).catch(() => undefined);
      }

      onComplete();
    } catch {
      setError('Network error — please try again');
    } finally {
      setBusy(false);
    }
  };

  const saveStep = async () => {
    setBusy(true);
    setSaveMsg('');
    setError('');
    try {
      const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${jwtToken}` };
      const needsCreds =
        (cfg.adapter.type === 'custom_api' && cfg.adapter.backendUrl) ||
        (cfg.adapter.type === 'webhook'    && cfg.adapter.webhookUrl);
      if (needsCreds) {
        const cr = await fetch('/api/admin/save-credentials', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            baseUrl:    cfg.adapter.backendUrl || undefined,
            apiKey:     cfg.adapter.apiKey     || undefined,
            webhookUrl: cfg.adapter.webhookUrl || undefined,
          }),
        });
        const crBody = await cr.json() as { ok?: boolean; error?: string };
        if (!cr.ok || !crBody.ok) { setError(crBody.error ?? 'Failed to save credentials'); return; }
      }

      const payload = {
        restaurantName: cfg.restaurantName,
        slug:           cfg.slug,
        plan:           cfg.plan,
        adapter: {
          type:             cfg.adapter.type,
          endpointMappings: cfg.adapter.type === 'custom_api' ? cfg.adapter.endpointMappings : undefined,
        },
        gemini:         cfg.gemini,
        branding:       cfg.branding,
        businessRules: {
          gstRate:            cfg.businessRules.gstRate,
          currencySymbol:     cfg.businessRules.currencySymbol,
          orderStatusMachine: ['pending','confirmed','preparing','ready','delivered'],
        },
        features: cfg.features,
        setupComplete: false,
        setupStep: step,
      };
      const r = await fetch('/api/admin/save-config', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(payload),
      });
      const body = await r.json() as { ok?: boolean; error?: string };
      if (!r.ok || !body.ok) { setError(body.error ?? 'Save failed'); return; }

      if (cfg.adapter.type !== 'custom_api' && menuData.categories.length > 0) {
        await fetch('/api/admin/menu', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(menuData),
        }).catch(() => undefined);
      }

      setSaveMsg(`Saved step ${step + 1}/8 — resuming from here`);
      setTimeout(() => setSaveMsg(''), 3000);
    } catch {
      setError('Network error — please try again');
    } finally {
      setBusy(false);
    }
  };

  const next = () => { setError(''); setStep(s => s + 1); };
  const back = () => { setError(''); setStep(s => s - 1); };

  return (
    <div className="flex h-full bg-[#F8F7F2] overflow-hidden">

      {/* Sidebar */}
      <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-[#5A5A40]/10 px-5 py-8">
        <div className="mb-8">
          <p className="text-xs font-bold text-[#5A5A40] uppercase tracking-widest">Setup Wizard</p>
          <p className="text-[10px] opacity-40 mt-0.5">{cfg.restaurantName}</p>
        </div>
        <nav className="flex flex-col gap-1 flex-1">
          {STEPS.map((label, i) => (
            <div
              key={label}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm ${
                i === step   ? 'bg-[#5A5A40] text-[#F8F7F2] font-semibold'
                : i < step   ? 'text-[#5A5A40] opacity-60'
                             : 'text-[#5A5A40] opacity-30'
              }`}
            >
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                i < step  ? 'bg-green-500 text-white'
                : i === step ? 'bg-white/20'
                             : 'border border-current'
              }`}>
                {i < step ? '✓' : i + 1}
              </span>
              {label}
            </div>
          ))}
        </nav>
        <button
          onClick={onLogout}
          className="text-xs opacity-40 hover:opacity-70 text-left cursor-pointer mt-4"
        >
          ← Sign out
        </button>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto flex flex-col">
        <div className="md:hidden flex gap-1.5 px-5 pt-5">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-all ${
                i <= step ? 'bg-[#5A5A40]' : 'bg-[#5A5A40]/15'
              }`}
            />
          ))}
        </div>

        <div className="flex-1 px-6 md:px-12 py-8 max-w-2xl mx-auto w-full">
          <p className="text-[10px] uppercase tracking-widest opacity-40 font-semibold mb-1">
            Step {step + 1} of {STEPS.length} — {STEPS.length - step - 1} step{STEPS.length - step - 1 === 1 ? '' : 's'} remaining
          </p>
          <h2 className="text-2xl font-serif font-bold text-[#5A5A40] mb-6">{STEPS[step]}</h2>

          {/* ── Step 0: Restaurant ────────────────────────────────────────── */}
          {step === 0 && (
            <div className="flex flex-col gap-4">
              <Field label="Restaurant Name">
                <input value={cfg.restaurantName}
                  onChange={e => setCfg(p => ({ ...p, restaurantName: e.target.value }))}
                  className={INPUT} placeholder="Savour Foods" />
              </Field>
              <Field label="Kiosk Title" hint="Shown on the welcome screen">
                <input value={cfg.branding.kioskTitle}
                  onChange={e => patch('branding', { kioskTitle: e.target.value })}
                  className={INPUT} placeholder="Welcome to Savour Foods" />
              </Field>
              <Field label="Logo URL (optional)">
                <input value={cfg.branding.logoUrl}
                  onChange={e => patch('branding', { logoUrl: e.target.value })}
                  className={INPUT} placeholder="https://…/logo.png" />
              </Field>
              <div className="flex gap-4">
                <Field label="Brand Colour">
                  <div className="flex items-center gap-3">
                    <input type="color" value={cfg.branding.primaryColor}
                      onChange={e => patch('branding', { primaryColor: e.target.value })}
                      className="w-10 h-10 rounded-lg border border-[#5A5A40]/15 cursor-pointer" />
                    <span className="text-sm font-mono opacity-60">{cfg.branding.primaryColor}</span>
                  </div>
                </Field>
                <Field label="Currency Symbol">
                  <input value={cfg.businessRules.currencySymbol}
                    onChange={e => patch('businessRules', { currencySymbol: e.target.value })}
                    className={INPUT + ' max-w-[80px]'} placeholder="$" maxLength={4} />
                </Field>
              </div>
            </div>
          )}

          {/* ── Step 1: Plan ──────────────────────────────────────────────── */}
          {step === 1 && (
            <div className="flex flex-col gap-4">
              <p className="text-sm opacity-60 leading-relaxed">
                Choose the plan that fits your restaurant. You can upgrade at any time from the Admin Dashboard.
              </p>
              <div className="flex flex-col gap-3">
                {PLANS.map(plan => (
                  <button
                    key={plan.id}
                    type="button"
                    onClick={() => setCfg(p => ({ ...p, plan: plan.id }))}
                    className={`rounded-2xl border p-4 text-left transition-all cursor-pointer ${
                      cfg.plan === plan.id
                        ? 'border-[#5A5A40] bg-[#5A5A40]/6 ring-1 ring-[#5A5A40]/20'
                        : 'border-[#5A5A40]/15 hover:border-[#5A5A40]/30'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-bold text-sm text-[#5A5A40]">{plan.name}</p>
                        <p className="text-xs opacity-55 mt-1 leading-relaxed">{plan.desc}</p>
                        <ul className="mt-2 flex flex-col gap-0.5">
                          {plan.features.map(f => (
                            <li key={f} className="text-xs opacity-50 flex items-center gap-1.5">
                              <span className="text-[#5A5A40] font-bold">·</span> {f}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <span className={`shrink-0 text-sm font-bold whitespace-nowrap ${
                        cfg.plan === plan.id ? 'text-[#5A5A40]' : 'opacity-40'
                      }`}>{plan.price}</span>
                    </div>
                  </button>
                ))}
              </div>
              <p className="text-[10px] opacity-40 leading-relaxed">
                Billing is handled separately — selecting a plan here sets your feature tier. Contact us to activate paid plans.
              </p>
            </div>
          )}

          {/* ── Step 2: Adapter ────────────────────────────────────────────── */}
          {step === 2 && (
            <div className="flex flex-col gap-4">
              <p className="text-sm opacity-60 leading-relaxed -mt-2">
                How do you take orders today? Pick the option that matches your restaurant — we'll handle the technical part.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {POS_PRESETS.map(preset => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => selectPreset(preset.id)}
                    className={`rounded-2xl border p-4 text-left transition-all cursor-pointer ${
                      cfg.adapter.presetId === preset.id
                        ? 'border-[#5A5A40] bg-[#5A5A40]/6 ring-1 ring-[#5A5A40]/20'
                        : 'border-[#5A5A40]/15 hover:border-[#5A5A40]/30'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-lg leading-none">{preset.icon}</span>
                      <p className="font-bold text-sm text-[#5A5A40]">{preset.name}</p>
                      {preset.recommended && (
                        <span className="ml-auto text-[9px] font-bold uppercase tracking-widest text-green-700 bg-green-100 px-1.5 py-0.5 rounded-full">
                          Recommended
                        </span>
                      )}
                    </div>
                    <p className="text-xs opacity-55 mt-1.5 leading-relaxed">{preset.tagline}</p>
                  </button>
                ))}
              </div>

              {(() => {
                const preset = getPreset(cfg.adapter.presetId);
                if (!preset) return null;
                return (
                  <div className="flex flex-col gap-3 mt-1 bg-white/40 rounded-2xl p-4 border border-[#5A5A40]/10">
                    {preset.setupNote && (
                      <p className="text-xs text-[#5A5A40] opacity-70 leading-relaxed">{preset.setupNote}</p>
                    )}

                    {preset.needsBaseUrl && (
                      <Field label={preset.baseUrlLabel ?? 'Backend URL'}>
                        <input value={cfg.adapter.backendUrl}
                          onChange={e => patch('adapter', { backendUrl: e.target.value })}
                          className={INPUT} placeholder={preset.baseUrlPlaceholder ?? 'https://api.myrestaurant.com'} />
                      </Field>
                    )}

                    {preset.needsApiKey && (
                      <Field label={preset.apiKeyLabel ?? 'API Key'} hint={preset.apiKeyHelp}>
                        <input type="password" value={cfg.adapter.apiKey}
                          onChange={e => patch('adapter', { apiKey: e.target.value })}
                          className={INPUT} placeholder="••••••••" />
                      </Field>
                    )}

                    {preset.needsWebhookUrl && (
                      <Field label={preset.webhookUrlLabel ?? 'Webhook URL'} hint={preset.webhookUrlHelp}>
                        <input value={cfg.adapter.webhookUrl}
                          onChange={e => patch('adapter', { webhookUrl: e.target.value })}
                          className={INPUT} placeholder="https://hooks.zapier.com/…" />
                      </Field>
                    )}

                    {preset.docsUrl && (
                      <a href={preset.docsUrl} target="_blank" rel="noreferrer"
                        className="text-xs text-[#5A5A40] underline opacity-60 hover:opacity-90 self-start">
                        Where do I find this? →
                      </a>
                    )}
                  </div>
                );
              })()}

              {cfg.adapter.type === 'custom_api' && (
                <div className="flex flex-col gap-3 bg-white/40 rounded-2xl p-4 border border-[#5A5A40]/10">
                  <div className="border-t-0 pt-0">
                    <button
                      type="button"
                      onClick={() => setShowEpConfig(s => !s)}
                      className="flex items-center gap-1.5 text-xs text-[#5A5A40] opacity-60 hover:opacity-90 cursor-pointer w-full text-left"
                    >
                      <span className="font-mono text-[10px]">{showEpConfig ? '▾' : '▸'}</span>
                      <span className="font-semibold uppercase tracking-widest">Advanced — Endpoint Configuration</span>
                      <span className="opacity-50 ml-1 normal-case tracking-normal font-normal">— optional, for developers</span>
                    </button>

                    {showEpConfig && (
                      <div className="mt-3 flex flex-col gap-2">
                        <p className="text-[10px] opacity-40 leading-snug mb-1">
                          Map each operation to your POS API endpoint. The defaults mirror our managed backend — only change if your API uses different paths.
                        </p>

                        {ENDPOINT_OPERATIONS.map(opDef => {
                          const m = cfg.adapter.endpointMappings.find(x => x.operation === opDef.key);
                          return (
                            <div key={opDef.key} className="flex flex-col gap-1 border-b border-[#5A5A40]/5 pb-2 last:border-0">
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-semibold text-[#5A5A40] w-36 shrink-0 opacity-80 leading-tight">
                                  {opDef.label}
                                </span>
                                <select
                                  value={m?.method ?? opDef.defaultMethod}
                                  onChange={e => patchMapping(opDef.key, { method: e.target.value as EndpointMappingDraft['method'] })}
                                  className="text-xs bg-white/80 border border-[#5A5A40]/15 rounded-lg px-2 py-1.5 focus:outline-none w-20 shrink-0 cursor-pointer"
                                >
                                  {(['GET','POST','PUT','PATCH','DELETE'] as const).map(v => (
                                    <option key={v} value={v}>{v}</option>
                                  ))}
                                </select>
                                <input
                                  value={m?.path ?? opDef.defaultPath}
                                  onChange={e => patchMapping(opDef.key, { path: e.target.value })}
                                  className="flex-1 text-xs bg-white/80 border border-[#5A5A40]/15 rounded-lg px-2 py-1.5 placeholder:opacity-25 focus:outline-none font-mono"
                                  placeholder={opDef.defaultPath}
                                />
                              </div>
                              <EndpointDiscovery
                                label={opDef.label}
                                method={m?.method ?? opDef.defaultMethod}
                                path={m?.path ?? opDef.defaultPath}
                                baseUrl={cfg.adapter.backendUrl}
                                apiKey={cfg.adapter.apiKey}
                                jwtToken={jwtToken}
                                params={m?.params}
                                onChange={p => patchMapping(opDef.key, { params: p })}
                              />
                            </div>
                          );
                        })}

                        <div className="mt-2 border-t border-[#5A5A40]/8 pt-3">
                          <button
                            type="button"
                            onClick={() => setShowFieldMap(s => !s)}
                            className="flex items-center gap-1.5 text-[10px] text-[#5A5A40] opacity-50 hover:opacity-80 cursor-pointer"
                          >
                            <span className="font-mono">{showFieldMap ? '▾' : '▸'}</span>
                            <span className="font-semibold uppercase tracking-widest">Response Field Mappings</span>
                            <span className="opacity-60 ml-1 normal-case tracking-normal font-normal">(Add to Cart)</span>
                          </button>
                          {showFieldMap && (
                            <div className="mt-2 flex flex-col gap-2 pl-1">
                              <p className="text-[10px] opacity-40 leading-snug">
                                If your <code className="font-mono bg-[#5A5A40]/8 px-0.5 rounded">Add to Cart</code> endpoint returns fields
                                under different names, enter the dot-notation path to each value.
                                Example: if the item ID is at <code className="font-mono bg-[#5A5A40]/8 px-0.5 rounded">data.item.id</code>,
                                enter that next to <code className="font-mono bg-[#5A5A40]/8 px-0.5 rounded">cart_item_id</code>.
                              </p>
                              {RESOLVE_ITEM_MAP_FIELDS.map(field => {
                                const m = cfg.adapter.endpointMappings.find(x => x.operation === 'resolveItem');
                                return (
                                  <div key={field.key} className="flex items-start gap-2">
                                    <span className="text-[10px] font-mono w-32 shrink-0 pt-2 text-[#5A5A40] opacity-60">
                                      {field.key}
                                    </span>
                                    <div className="flex-1">
                                      <input
                                        value={m?.fieldMappings?.[field.key] ?? ''}
                                        onChange={e => setFieldMapping('resolveItem', field.key, e.target.value)}
                                        placeholder={`their.path.for.${field.key}`}
                                        className="w-full text-xs bg-white/80 border border-[#5A5A40]/15 rounded-lg px-2 py-1.5 placeholder:opacity-25 focus:outline-none font-mono"
                                      />
                                      <p className="text-[9px] opacity-35 mt-0.5">{field.hint}</p>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Step 3: Test Connection ────────────────────────────────────── */}
          {step === 3 && (
            <div className="flex flex-col gap-4">
              <p className="text-sm opacity-60 leading-relaxed">
                We'll verify the connection to your {cfg.adapter.type === 'managed' ? 'managed' : 'custom'} backend
                and fetch a sample of the menu context Gemini will use.
              </p>
              <button
                onClick={runTest} disabled={busy}
                className="self-start px-6 py-3 bg-[#5A5A40] text-[#F8F7F2] rounded-xl font-bold text-sm uppercase tracking-widest hover:bg-[#4a4a33] active:scale-95 transition-all disabled:opacity-50 cursor-pointer"
              >
                {busy ? 'Testing…' : 'Test Connection'}
              </button>
              {testResult && (
                <div className={`rounded-2xl p-4 border text-sm ${
                  testResult.ok
                    ? 'bg-green-50 border-green-200 text-green-800'
                    : 'bg-red-50   border-red-200   text-red-700'
                }`}>
                  <p className="font-bold mb-1">{testResult.ok ? '✓ Connected' : '✗ Connection failed'}</p>
                  <pre className="whitespace-pre-wrap font-mono text-xs opacity-80 max-h-40 overflow-y-auto">{testResult.msg}</pre>
                </div>
              )}
              <p className="text-xs opacity-40">
                You can skip this step and test later from the Admin Dashboard.
              </p>
            </div>
          )}

          {/* ── Step 4: Menu ──────────────────────────────────────────────── */}
          {step === 4 && (
            <div className="flex flex-col gap-4">
              {cfg.adapter.type === 'custom_api' ? (
                <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
                  <p className="text-sm font-bold text-blue-800 mb-1">Menu comes from your API</p>
                  <p className="text-xs text-blue-700 leading-relaxed">
                    For Custom API adapters, the menu is fetched directly from your backend endpoint.
                    No setup needed here — click Next to continue.
                  </p>
                </div>
              ) : (
                <>
                  <p className="text-sm opacity-60 leading-relaxed">
                    Add your menu categories and items. You can edit or extend this any time from the Admin Dashboard → Menu tab.
                  </p>

                  {menuData.categories.map(cat => (
                    <div key={cat.id} className="bg-white/60 rounded-2xl border border-[#5A5A40]/10 p-4 flex flex-col gap-2">
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

                      {menuData.items.filter(i => i.categoryId === cat.id).map(item => (
                        <div key={item.id} className="grid grid-cols-[1fr_1fr_80px_auto] gap-2 items-center">
                          <input value={item.name}
                            onChange={e => updateItem(item.id, { name: e.target.value })}
                            className={INPUT} placeholder="Item name" />
                          <input value={item.description}
                            onChange={e => updateItem(item.id, { description: e.target.value })}
                            className={INPUT} placeholder="Description" />
                          <input type="number" min="0" step="0.01" value={item.price}
                            onChange={e => updateItem(item.id, { price: Number(e.target.value) })}
                            className={INPUT} placeholder="0.00" />
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
                  {menuData.categories.length === 0 && (
                    <p className="text-xs opacity-40">You can skip this and add menu items later from the Admin Dashboard.</p>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── Step 5: AI Persona ─────────────────────────────────────────── */}
          {step === 5 && (
            <div className="flex flex-col gap-4">
              <Field label="Agent Name" hint="How the AI introduces itself">
                <input value={cfg.gemini.agentName}
                  onChange={e => patch('gemini', { agentName: e.target.value })}
                  className={INPUT} placeholder="Savour Assistant" />
              </Field>

              <Field label="Voice" hint="Click a name to select · ▶ to preview">
                <div className="grid grid-cols-3 gap-2">
                  {VOICES.map(v => (
                    <div key={v} className="relative group">
                      <button type="button"
                        onClick={() => patch('gemini', { voice: v })}
                        className={`w-full py-2 pr-7 rounded-xl text-sm font-semibold border transition-all cursor-pointer ${
                          cfg.gemini.voice === v
                            ? 'bg-[#5A5A40] text-[#F8F7F2] border-[#5A5A40]'
                            : 'border-[#5A5A40]/15 text-[#5A5A40] hover:border-[#5A5A40]/40'
                        }`}
                      >{v}</button>
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); playVoicePreview(v); }}
                        disabled={previewingVoice !== null}
                        title="Preview voice"
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] opacity-50 hover:opacity-100 disabled:opacity-20 cursor-pointer transition"
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
                    const on = cfg.gemini.languages.includes(l.code);
                    return (
                      <button key={l.code} type="button"
                        onClick={() => patch('gemini', {
                          languages: on
                            ? cfg.gemini.languages.filter(x => x !== l.code)
                            : [...cfg.gemini.languages, l.code],
                        })}
                        className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all cursor-pointer ${
                          on
                            ? 'bg-[#5A5A40] text-[#F8F7F2] border-[#5A5A40]'
                            : 'border-[#5A5A40]/20 text-[#5A5A40] hover:border-[#5A5A40]/50'
                        }`}
                      >{l.label}</button>
                    );
                  })}
                </div>
              </Field>

              <Field label="Extra Instructions (optional)" hint="Brand rules, drink mappings, upsell scripts, etc.">
                <textarea rows={5} value={cfg.gemini.systemPromptExtras}
                  onChange={e => patch('gemini', { systemPromptExtras: e.target.value })}
                  className={INPUT + ' resize-none'}
                  placeholder={'DRINK RULES:\n- "cola" → use "Cola Next"\n- "sprite" → use "Fizzup"'}
                />
              </Field>
            </div>
          )}

          {/* ── Step 6: Business Rules ─────────────────────────────────────── */}
          {step === 6 && (
            <div className="flex flex-col gap-5">
              <div className="flex gap-4 flex-wrap">
                <Field label="GST / Tax Rate (%)">
                  <input
                    type="number" min="0" max="100" step="0.1"
                    value={cfg.businessRules.gstRate * 100}
                    onChange={e => patch('businessRules', { gstRate: Number(e.target.value) / 100 })}
                    className={INPUT + ' max-w-[100px]'} placeholder="0"
                  />
                </Field>
                <Field label="Currency Symbol">
                  <input value={cfg.businessRules.currencySymbol}
                    onChange={e => patch('businessRules', { currencySymbol: e.target.value })}
                    className={INPUT + ' max-w-[80px]'} placeholder="$" maxLength={4} />
                </Field>
              </div>

              <div className="bg-white/40 rounded-2xl border border-[#5A5A40]/10 p-4 flex flex-col gap-3">
                <p className="text-[11px] uppercase tracking-widest opacity-40 font-semibold">Features</p>
                {([
                  { key: 'deliveryOrders',   label: 'Delivery Orders',    desc: 'Allow customers to place delivery orders' },
                  { key: 'tableNumbers',     label: 'Table Numbers',      desc: 'Ask for table number at checkout' },
                  { key: 'transcriptScreen', label: 'Transcript Screen',  desc: 'Show live conversation transcript to staff' },
                  { key: 'loyaltyPoints',    label: 'Loyalty Points',     desc: 'Collect phone numbers for loyalty program' },
                ] as const).map(f => (
                  <label key={f.key} className="flex items-center justify-between gap-3 cursor-pointer group">
                    <span>
                      <p className="text-sm font-semibold text-[#5A5A40]">{f.label}</p>
                      <p className="text-[11px] opacity-45">{f.desc}</p>
                    </span>
                    <button
                      type="button"
                      onClick={() => patch('features', { [f.key]: !cfg.features[f.key] })}
                      className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer shrink-0 ${
                        cfg.features[f.key] ? 'bg-[#5A5A40]' : 'bg-[#5A5A40]/20'
                      }`}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                        cfg.features[f.key] ? 'translate-x-5' : 'translate-x-0.5'
                      }`} />
                    </button>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* ── Step 7: Launch ─────────────────────────────────────────────── */}
          {step === 7 && (
            <div className="flex flex-col gap-5">
              <div className="bg-white/60 rounded-2xl border border-[#5A5A40]/10 p-5 flex flex-col gap-3">
                <Row label="Restaurant"  value={cfg.restaurantName} />
                <Row label="Kiosk URL"   value={`/kiosk/${cfg.slug}`} mono />
                <Row label="Plan"        value={cfg.plan} />
                <Row label="Connection"  value={
                  (getPreset(cfg.adapter.presetId)?.name ?? 'Custom') +
                  (cfg.adapter.type === 'custom_api' && cfg.adapter.backendUrl ? ` — ${cfg.adapter.backendUrl}`
                   : cfg.adapter.type === 'webhook'  && cfg.adapter.webhookUrl ? ` — ${cfg.adapter.webhookUrl}`
                   : '')
                } />
                <Row label="AI Agent"    value={`${cfg.gemini.agentName} (${cfg.gemini.voice})`} />
                <Row label="Languages"   value={cfg.gemini.languages.join(', ')} />
                <Row label="GST"         value={`${(cfg.businessRules.gstRate * 100).toFixed(1)}%`} />
                <Row label="Currency"    value={cfg.businessRules.currencySymbol} />
              </div>

              <button
                onClick={saveAndLaunch} disabled={busy}
                className="w-full py-4 bg-[#5A5A40] text-[#F8F7F2] rounded-2xl font-bold uppercase tracking-widest text-sm hover:bg-[#4a4a33] active:scale-[0.98] transition-all disabled:opacity-50 cursor-pointer"
              >
                {busy ? 'Saving…' : '🚀  Complete Setup'}
              </button>
            </div>
          )}

          {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
          {saveMsg && <p className="text-xs text-green-600 mt-2">{saveMsg}</p>}

          <div className="flex justify-between gap-3 mt-8 flex-wrap">
            <div className="flex gap-2">
              <button
                onClick={back} disabled={step === 0}
                className="px-5 py-2.5 border border-[#5A5A40]/20 rounded-xl text-sm text-[#5A5A40] hover:border-[#5A5A40]/50 transition disabled:opacity-0 cursor-pointer"
              >
                ← Back
              </button>
              <button
                onClick={saveStep} disabled={busy}
                className="px-5 py-2.5 border border-blue-200 text-blue-600 rounded-xl text-sm font-semibold hover:bg-blue-50 transition disabled:opacity-50 cursor-pointer"
              >
                {busy ? 'Saving…' : '💾 Save'}
              </button>
            </div>
            <button
              onClick={onExit}
              className="px-5 py-2.5 border border-[#5A5A40]/20 text-[#5A5A40] rounded-xl text-sm hover:border-[#5A5A40]/50 transition cursor-pointer"
            >
              Back to Dashboard
            </button>
            {step < STEPS.length - 1 && (
              <button
                onClick={next}
                className="px-5 py-2.5 bg-[#5A5A40] text-[#F8F7F2] rounded-xl text-sm font-semibold hover:bg-[#4a4a33] active:scale-95 transition cursor-pointer"
              >
                Next →
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

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

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between items-start gap-4 border-b border-[#5A5A40]/6 pb-2 last:border-0 last:pb-0">
      <span className="text-[11px] uppercase tracking-widest opacity-40 font-semibold shrink-0">{label}</span>
      <span className={`text-sm text-right text-[#3D3D33] ${mono ? 'font-mono' : 'font-semibold'}`}>{value}</span>
    </div>
  );
}
