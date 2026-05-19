import axios from 'axios';

// Direct read-only client for the Supabase `v_menu` view, used as the source
// of truth for tenants whose menu lives in Supabase (currently Savour Foods).
//
// The view exposes columns:
//   tenant_id, category, category_priority, dish_id, dish_name,
//   description, tag, display_price, price, base_price, status, availability
//
// We never write to this view from the kiosk admin panel — it's owned by the
// Render/FastAPI backend's menu sync flow. Reading directly here bypasses the
// Render `/api/v1/menu` hop, which avoids Render cold-starts and prevents the
// admin panel's `menu:data:<tenantId>` Redis cache from masking the real menu.

interface VMenuRow {
  tenant_id:        string;
  category:         string;
  category_priority: number;
  dish_id:          number;
  dish_name:        string | null;
  description:      string | null;
  display_price:    number | string;
  status:           number;  // 1 = active
  availability:     number;  // 1 = available
}

export interface MenuCategory { id: string; name: string; sortOrder: number }
export interface MenuItem     { id: string; categoryId: string; name: string; description: string; price: number; available: boolean }
export interface MenuData     { categories: MenuCategory[]; items: MenuItem[] }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function categoryId(name: string): string {
  return `cat:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

export async function fetchMenuFromSupabase(tenantId: string): Promise<MenuData> {
  if (!UUID_RE.test(tenantId)) {
    throw new Error(`[SUPABASE] refusing menu fetch — invalid tenantId "${tenantId}"`);
  }

  const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
  // Accept either name — older .env files used SUPABASE_KEY before the SaaS
  // refactor renamed it. New deployments should prefer SUPABASE_SERVICE_ROLE_KEY.
  const apiKey  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error('[SUPABASE] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or legacy SUPABASE_KEY) must be set');
  }

  const res = await axios.get<VMenuRow[]>(`${baseUrl}/rest/v1/v_menu`, {
    params: {
      select:       'tenant_id,category,category_priority,dish_id,dish_name,description,display_price,status,availability',
      tenant_id:    `eq.${tenantId}`,
      status:       'eq.1',
      availability: 'eq.1',
    },
    headers: {
      apikey:        apiKey,
      Authorization: `Bearer ${apiKey}`,
      Accept:        'application/json',
    },
    timeout: 15_000,
  });

  // Defensive: PostgREST filters server-side but double-check tenant_id so a
  // misconfigured policy never leaks cross-tenant rows into this response.
  const rows = (res.data ?? []).filter(r =>
    r.tenant_id === tenantId &&
    typeof r.dish_name === 'string' &&
    r.dish_name.trim().length > 0,
  );

  const catMap = new Map<string, MenuCategory>();
  for (const r of rows) {
    if (!catMap.has(r.category)) {
      catMap.set(r.category, {
        id:        categoryId(r.category),
        name:      r.category,
        // Higher category_priority means higher up the menu — invert so the
        // existing sortOrder ascending sort produces the expected order.
        sortOrder: 1_000_000 - (r.category_priority ?? 0),
      });
    }
  }

  const items: MenuItem[] = rows.map(r => ({
    id:          `dish:${r.dish_id}`,
    categoryId:  catMap.get(r.category)!.id,
    name:        (r.dish_name ?? '').trim(),
    description: (r.description ?? '').trim(),
    price:       Number(r.display_price ?? 0),
    available:   r.availability === 1 && r.status === 1,
  }));

  return {
    categories: [...catMap.values()].sort((a, b) => a.sortOrder - b.sortOrder),
    items,
  };
}
