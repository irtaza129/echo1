import { useState } from 'react';
import { tenantFetch } from '../lib/apiClient';

// Guards anything that lives behind requireFeature('pos') — till PINs, tables/QR
// — with a one-tap way to turn it on, instead of a raw 403.
//
// The same "read config, flip two fields, save" the wizard and PinGate use. This
// is the third of three places that ever set adapter.type = 'pos', and all three
// agree: the Till always keeps its own orders in our database, so turning it on
// switches ordering to match — otherwise the till and the ordering channels
// would keep two order lists that never agree.

export default function EnablePosGate({
  currentAdapterType, onEnabled,
}: {
  currentAdapterType: string;
  onEnabled: () => void;
}) {
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enable() {
    setBusy(true); setError(null);
    try {
      const cfgRes = await tenantFetch('/api/admin/my-config');
      if (!cfgRes.ok) throw new Error(`Could not read settings (${cfgRes.status})`);
      const config = await cfgRes.json() as Record<string, unknown> & {
        features?: Record<string, unknown>;
        adapter?:  Record<string, unknown>;
      };

      const res = await tenantFetch('/api/admin/save-config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...config,
          features: { ...config.features, pos: true },
          adapter:  { ...config.adapter, type: 'pos' },
        }),
      });
      const body = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? 'Could not save');

      onEnabled();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 text-center">
      <h3 className="font-bold text-amber-900 mb-1">The Till isn't turned on yet</h3>
      <p className="text-sm text-amber-800 mb-4">
        {currentAdapterType !== 'pos' && currentAdapterType !== 'managed'
          ? 'This restaurant is currently ordering through a connected system. '
          : ''}
        One tap turns on the till, kitchen display and table ordering — this only
        needs doing once.
      </p>
      {error && <p className="text-sm text-red-700 mb-3">{error}</p>}
      <button
        onClick={() => void enable()}
        disabled={busy}
        className="min-h-[48px] px-6 rounded-xl bg-slate-900 text-white font-bold disabled:opacity-40 cursor-pointer"
      >
        {busy ? 'Turning on…' : 'Turn on the Till'}
      </button>
    </div>
  );
}
