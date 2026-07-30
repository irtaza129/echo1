import { getRedis, redisKey } from './redis.js';

export interface MenuCategoryRow { id: string; name: string; sortOrder: number }
export interface MenuItemRow     { id: string; categoryId: string; name: string; description: string; price: number; available: boolean }
export interface MenuData        { categories: MenuCategoryRow[]; items: MenuItemRow[] }

export interface LocalCartItem {
  cart_item_id: string;
  name:         string;
  category:     string;
  summary:      string;
  quantity:     number;
  unit_price:   number;
  modifiers:    string[];
  notes:        string | null;
}

export interface LocalOrder {
  id:             string;
  order_number:   number;
  tenant_id:      string;
  status:         string;
  items:          LocalCartItem[];
  subtotal:       number;
  total:          number;
  customer_name:  string;
  customer_phone: string;
  order_type:     string;
  payment_method: string;
  payment_status?: string;
  payment_ref?:    string;
  notes:          string | null;
  created_at:     string;
  updated_at:     string;
}

// Tenants whose menu lives in Supabase v_menu — never read from menu:data:<id>.
export const SAVOUR_FOODS_TENANT_ID = '00000000-0000-4000-8000-000000000001';
export const SUPABASE_MENU_TENANTS  = new Set<string>([SAVOUR_FOODS_TENANT_ID]);

export function normStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

export function fuzzyMatchItem(query: string, items: MenuItemRow[]): MenuItemRow | null {
  const q     = normStr(query);
  const avail = items.filter(i => i.available !== false && i.name.trim() !== '');

  let m = avail.find(i => normStr(i.name) === q);
  if (m) return m;

  m = avail.find(i => { const n = normStr(i.name); return n.includes(q) || q.includes(n); });
  if (m) return m;

  const qw = q.split(' ').filter(w => w.length > 1);
  let best: MenuItemRow | null = null;
  let top = 0;
  for (const item of avail) {
    const iw    = normStr(item.name).split(' ').filter(w => w.length > 1);
    const hits  = qw.filter(w => iw.some(iw2 => iw2 === w || iw2.startsWith(w) || w.startsWith(iw2))).length;
    const score = hits / Math.max(qw.length, iw.length, 1);
    if (score > top) { top = score; best = item; }
  }
  return top >= 0.35 ? best : null;
}

// Returns admin-managed menu from Redis, or null to fall through to the adapter.
// Tenants in SUPABASE_MENU_TENANTS always return null.
export async function getLocalMenu(tenantId: string): Promise<MenuData | null> {
  if (SUPABASE_MENU_TENANTS.has(tenantId)) return null;
  try {
    const data = await getRedis().get<MenuData>(redisKey.menuData(tenantId));
    return data ?? null;
  } catch {
    return null;
  }
}
