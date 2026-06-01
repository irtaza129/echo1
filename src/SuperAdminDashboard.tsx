import { useState, useEffect } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TenantSummary {
  tenantId:       string;
  slug:           string;
  restaurantName: string;
  plan:           string;
  adapter:        { type: string };
  gemini:         { voice: string; languages: string[] };
}

interface AdapterTemplate {
  id:            string;
  name:          string;
  description:   string;
  adapterConfig: Record<string, string>;
}

interface Props {
  jwtToken:       string;
  onLogout:       () => void;
  onManageTenant: (jwt: string, slug: string) => void;
}

type Tab = 'tenants' | 'templates';

// ── Component ─────────────────────────────────────────────────────────────────

export default function SuperAdminDashboard({ jwtToken, onLogout, onManageTenant }: Props) {
  const [tab,           setTab]           = useState<Tab>('tenants');
  const [tenants,       setTenants]       = useState<TenantSummary[]>([]);
  const [templates,     setTemplates]     = useState<AdapterTemplate[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState('');
  const [impersonating, setImpersonating] = useState<string | null>(null);

  const auth = { Authorization: `Bearer ${jwtToken}` };

  useEffect(() => {
    Promise.all([
      fetch('/api/super/tenants',           { headers: auth }).then(r => r.json() as Promise<TenantSummary[]>),
      fetch('/api/super/adapter-templates', { headers: auth }).then(r => r.json() as Promise<AdapterTemplate[]>),
    ])
      .then(([t, tmpl]) => { setTenants(Array.isArray(t) ? t : []); setTemplates(Array.isArray(tmpl) ? tmpl : []); })
      .catch(() => setError('Failed to load super admin data'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleImpersonate = async (tenantId: string, slug: string) => {
    setImpersonating(tenantId);
    try {
      const r = await fetch(`/api/super/tenants/${tenantId}/impersonate`, {
        method: 'POST', headers: auth,
      });
      const body = await r.json() as { jwtToken?: string; slug?: string; error?: string };
      if (!r.ok || !body.jwtToken) { alert(body.error ?? 'Impersonation failed'); return; }
      onManageTenant(body.jwtToken, body.slug ?? slug);
    } catch (err) {
      alert(String(err));
    } finally {
      setImpersonating(null);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#F8F7F2] overflow-hidden">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-[#5A5A40]/10 bg-white/50">
        <div>
          <h1 className="font-serif font-bold text-[#5A5A40] text-lg leading-tight">Super Admin</h1>
          <p className="text-[10px] uppercase tracking-widest opacity-40 mt-0.5">Platform Control Panel</p>
        </div>
        <button
          onClick={onLogout}
          className="px-3 py-2 text-xs font-semibold text-red-600 border border-red-200 rounded-xl hover:bg-red-50 transition cursor-pointer"
        >
          Sign Out
        </button>
      </header>

      {/* ── Tabs ────────────────────────────────────────────────────────────── */}
      <nav className="shrink-0 flex border-b border-[#5A5A40]/10 px-5 bg-white/30">
        {(['tenants', 'templates'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-3 text-xs font-semibold uppercase tracking-widest transition border-b-2 cursor-pointer ${
              tab === t
                ? 'border-[#5A5A40] text-[#5A5A40]'
                : 'border-transparent text-[#5A5A40] opacity-40 hover:opacity-70'
            }`}
          >
            {t === 'tenants' ? `Tenants (${tenants.length})` : 'Adapter Templates'}
          </button>
        ))}
      </nav>

      {/* ── Content ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-5 max-w-4xl mx-auto w-full">

        {loading && <p className="text-sm opacity-40 text-center py-12">Loading…</p>}
        {error   && <p className="text-sm text-red-500 text-center py-12">{error}</p>}

        {/* Tenant list */}
        {!loading && !error && tab === 'tenants' && (
          <div className="flex flex-col gap-3">
            {tenants.length === 0 && (
              <div className="bg-white/60 border border-white/80 rounded-2xl p-8 text-center">
                <p className="text-sm opacity-40">No tenants registered yet.</p>
                <p className="text-xs opacity-30 mt-1">Tenants appear here after signing up via the registration flow.</p>
              </div>
            )}
            {tenants.map(t => (
              <div
                key={t.tenantId}
                className="bg-white/60 border border-white/80 rounded-2xl p-5 flex items-start justify-between gap-4"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-[#5A5A40] truncate">{t.restaurantName}</p>
                  <p className="text-xs font-mono opacity-40 mt-0.5">/kiosk/{t.slug}</p>
                  <div className="flex gap-2 mt-2 flex-wrap">
                    <Badge label={t.plan} />
                    <Badge label={t.adapter?.type ?? 'unknown'} />
                    <Badge label={`${t.gemini?.languages?.length ?? 0} lang`} />
                    <Badge label={`voice: ${t.gemini?.voice ?? '—'}`} />
                  </div>
                  <p className="text-[10px] font-mono opacity-30 mt-2 truncate">{t.tenantId}</p>
                </div>
                <button
                  onClick={() => handleImpersonate(t.tenantId, t.slug)}
                  disabled={impersonating === t.tenantId}
                  className="shrink-0 px-3 py-2 text-xs font-semibold text-[#5A5A40] border border-[#5A5A40]/20 rounded-xl hover:border-[#5A5A40]/50 transition cursor-pointer disabled:opacity-50"
                >
                  {impersonating === t.tenantId ? 'Opening…' : 'Manage →'}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Adapter templates */}
        {!loading && !error && tab === 'templates' && (
          <div className="flex flex-col gap-3">
            {templates.map(t => (
              <div key={t.id} className="bg-white/60 border border-white/80 rounded-2xl p-5">
                <p className="font-bold text-[#5A5A40]">{t.name}</p>
                <p className="text-sm opacity-60 mt-1">{t.description}</p>
                <pre className="mt-3 text-xs font-mono bg-[#5A5A40]/5 rounded-xl p-3 overflow-x-auto text-[#3D3D33] leading-relaxed">
                  {JSON.stringify(t.adapterConfig, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Shared primitives ─────────────────────────────────────────────────────────

function Badge({ label }: { label: string }) {
  return (
    <span className="text-[10px] uppercase tracking-widest font-semibold px-2 py-0.5 rounded-full bg-[#5A5A40]/8 text-[#5A5A40]">
      {label}
    </span>
  );
}
