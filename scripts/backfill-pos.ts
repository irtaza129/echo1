// One-shot backfill: move a tenant's Redis-backed menu and orders into the
// Postgres tables the POS reads, then (optionally) switch them onto PosAdapter.
//
//   npx tsx scripts/backfill-pos.ts --dry-run              # report only, default
//   npx tsx scripts/backfill-pos.ts --tenant <uuid>        # migrate one tenant
//   npx tsx scripts/backfill-pos.ts --tenant <uuid> --write
//   npx tsx scripts/backfill-pos.ts --tenant <uuid> --write --activate
//
// `--activate` is separate from `--write` on purpose. Copying the data is safe
// and repeatable; flipping adapter.type to 'pos' changes which code path serves
// a live kiosk, and should be a deliberate second step taken once the copied
// data has been eyeballed.
//
// Idempotent: menu rows are matched on (tenant_id, name) and skipped if already
// present, and orders are matched on their existing uuid.
//
// KNOWN LIMITATION — read before running:
// `categories`, `sub_categories` and `dishes` have integer primary keys with NO
// database default (FastAPI assigns them). This script therefore allocates ids
// as max(id)+1 across the whole table, which is safe only while nothing else is
// inserting concurrently. Run it during a quiet window, one tenant at a time.

import 'dotenv/config';
import { getRedis, redisKey } from '../src/lib/redis.js';
import * as db from '../src/lib/supabaseAdmin.js';
import { tenantConfigsRepo } from '../src/lib/repo.js';
import { parseTenantConfig } from '../src/lib/tenantConfig.js';

const DRY_RUN  = !process.argv.includes('--write');
const ACTIVATE = process.argv.includes('--activate');
const TENANT   = (() => {
  const i = process.argv.indexOf('--tenant');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

// Redis storage shapes (see server.ts — these are the pre-POS local formats).
interface MenuCategoryRow { id: string; name: string; sortOrder: number }
interface MenuItemRow     { id: string; categoryId: string; name: string; description: string; price: number; available: boolean }
interface MenuData        { categories: MenuCategoryRow[]; items: MenuItemRow[] }

interface LocalCartItem {
  cart_item_id: string; name: string; category: string; summary: string;
  quantity: number; unit_price: number; modifiers: string[]; notes: string | null;
}
interface LocalOrder {
  id: string; order_number: number; tenant_id: string; status: string;
  items: LocalCartItem[]; subtotal: number; total: number;
  customer_name: string; customer_phone: string; order_type: string;
  payment_method: string; notes: string | null; created_at: string; updated_at: string;
}

async function nextId(table: string): Promise<number> {
  const rows = await db.selectMany<{ id: number }>(table, { select: 'id', order: 'id.desc', limit: '1' });
  return (rows[0]?.id ?? 0) + 1;
}

async function backfillMenu(tenantId: string): Promise<{ categories: number; dishes: number }> {
  const menu = await getRedis().get<MenuData>(redisKey.menuData(tenantId)).catch(() => null);
  if (!menu) {
    console.log(`[POS-BACKFILL] no Redis menu for ${tenantId} — nothing to copy`);
    return { categories: 0, dishes: 0 };
  }

  const existingCats = await db.selectMany<{ id: number; name: string }>('categories', {
    tenant_id: `eq.${tenantId}`, select: 'id,name',
  });
  const catByName = new Map(existingCats.map(c => [c.name.toLowerCase(), c.id]));

  let catId = await nextId('categories');
  let subId = await nextId('sub_categories');
  let dishId = await nextId('dishes');

  // Redis category id (e.g. "cat:pulao") → Postgres integer id
  const catIdMap = new Map<string, number>();
  // Every dish needs a sub_category_id (NOT NULL), so each category gets one
  // catch-all sub-category. The Redis menu model has no sub-category concept.
  const subIdMap = new Map<string, number>();

  let categoriesWritten = 0;
  for (const cat of [...menu.categories].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const existing = catByName.get(cat.name.toLowerCase());
    if (existing !== undefined) {
      catIdMap.set(cat.id, existing);
      const subs = await db.selectMany<{ id: number }>('sub_categories', {
        tenant_id: `eq.${tenantId}`, category_id: `eq.${existing}`, select: 'id', limit: '1',
      });
      if (subs[0]) { subIdMap.set(cat.id, subs[0].id); continue; }
    }

    const newCatId = existing ?? catId++;
    const newSubId = subId++;
    catIdMap.set(cat.id, newCatId);
    subIdMap.set(cat.id, newSubId);

    if (DRY_RUN) {
      console.log(`[POS-BACKFILL]   would add category "${cat.name}" (id ${newCatId})`);
    } else {
      if (existing === undefined) {
        await db.insert('categories', {
          id: newCatId, tenant_id: tenantId, name: cat.name,
          status: 1,
          // Redis sortOrder is ascending; `priority` is descending. Invert so
          // the menu keeps the order the tenant arranged.
          priority: 1_000_000 - cat.sortOrder,
        });
      }
      await db.insert('sub_categories', {
        id: newSubId, tenant_id: tenantId, category_id: newCatId, name: cat.name, status: 1,
      });
    }
    categoriesWritten++;
  }

  const existingDishes = await db.selectMany<{ name: string }>('dishes', {
    tenant_id: `eq.${tenantId}`, select: 'name',
  });
  const dishNames = new Set(existingDishes.map(d => d.name.toLowerCase()));

  let dishesWritten = 0;
  for (const item of menu.items) {
    if (dishNames.has(item.name.toLowerCase())) continue;

    const cid = catIdMap.get(item.categoryId);
    const sid = subIdMap.get(item.categoryId);
    if (cid === undefined || sid === undefined) {
      console.warn(`[POS-BACKFILL]   skip dish "${item.name}" — unknown category ${item.categoryId}`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`[POS-BACKFILL]   would add dish "${item.name}" @ ${item.price}`);
    } else {
      await db.insert('dishes', {
        id:              dishId++,
        tenant_id:       tenantId,
        category_id:     cid,
        sub_category_id: sid,
        name:            item.name,
        description:     item.description ?? '',
        price:           item.price,
        base_price:      item.price,
        status:          1,
        availability:    item.available === false ? 0 : 1,
      });
    }
    dishesWritten++;
  }

  return { categories: categoriesWritten, dishes: dishesWritten };
}

async function backfillOrders(tenantId: string): Promise<number> {
  const redis = getRedis();
  const ids   = await redis.lrange(redisKey.localOrders(tenantId), 0, -1).catch(() => [] as string[]);
  if (ids.length === 0) {
    console.log(`[POS-BACKFILL] no Redis orders for ${tenantId}`);
    return 0;
  }

  const existing = await db.selectMany<{ id: string }>('orders', {
    tenant_id: `eq.${tenantId}`, select: 'id',
  });
  const known = new Set(existing.map(o => o.id));

  let written = 0;
  for (const id of ids) {
    if (known.has(id)) continue;

    const order = await redis.get<LocalOrder>(redisKey.localOrder(id)).catch(() => null);
    if (!order) continue;   // expired under TTL.LOCAL_ORDER — nothing to recover

    if (DRY_RUN) {
      console.log(`[POS-BACKFILL]   would copy order #${order.order_number} (${order.items.length} lines, total ${order.total})`);
      written++;
      continue;
    }

    await db.insert('orders', {
      id:             order.id,
      tenant_id:      tenantId,
      order_number:   order.order_number,
      customer_name:  order.customer_name  || 'Guest',
      customer_phone: order.customer_phone || '',
      order_type:     order.order_type,
      status:         order.status,
      payment_method: order.payment_method,
      payment_status: 'unpaid',
      subtotal:       order.subtotal,
      discount:       0,
      delivery_fee:   0,
      // The Redis model stored only subtotal and total; tax is the difference.
      // Recovering it this way keeps historical receipts internally consistent
      // rather than recording zero tax on every migrated order.
      tax_total:      Math.max(0, Math.round((order.total - order.subtotal) * 100) / 100),
      total_amount:   order.total,
      notes:          order.notes,
      source:         'kiosk',
      opened_at:      order.created_at,
      closed_at:      order.updated_at,
      created_at:     order.created_at,
      updated_at:     order.updated_at,
    });

    await db.insertMany('order_items', order.items.map(i => ({
      tenant_id:        tenantId,
      order_id:         order.id,
      dish_id:          null,   // Redis lines never recorded one — see migration 007
      dish_name:        i.name,
      quantity:         i.quantity,
      unit_price:       i.unit_price,
      // item_total omitted on purpose — it is a GENERATED ALWAYS column and
      // Postgres rejects any insert that supplies a value for it.
      selected_options: (i.modifiers ?? []).map(m => ({ choice_name: m })),
      notes:            i.notes,
    })));

    written++;
  }

  return written;
}

async function run() {
  if (!TENANT) {
    console.error('Usage: npx tsx scripts/backfill-pos.ts --tenant <uuid> [--write] [--activate]');
    process.exit(1);
  }

  console.log(`[POS-BACKFILL] tenant ${TENANT} — ${DRY_RUN ? 'DRY RUN (pass --write to apply)' : 'WRITING'}`);

  const menu   = await backfillMenu(TENANT);
  const orders = await backfillOrders(TENANT);

  console.log(`[POS-BACKFILL] categories: ${menu.categories}, dishes: ${menu.dishes}, orders: ${orders}`);

  if (!ACTIVATE) {
    console.log('[POS-BACKFILL] adapter.type unchanged — re-run with --write --activate to switch this tenant onto the POS');
    return;
  }

  const raw = await tenantConfigsRepo.get(TENANT);
  if (!raw) { console.error('[POS-BACKFILL] no tenant_config row — cannot activate'); process.exit(1); }

  const config = parseTenantConfig(raw);
  const next   = {
    ...config,
    adapter:  { ...config.adapter, type: 'pos' as const },
    features: { ...config.features, pos: true },
  };

  if (DRY_RUN) {
    console.log(`[POS-BACKFILL] would set adapter.type=pos and features.pos=true for ${config.slug}`);
    return;
  }

  await tenantConfigsRepo.upsert(TENANT, next);

  // The middleware reads tenant configs from Redis first, so the stale cached
  // copy has to go or the flip will not take effect until its TTL expires.
  await getRedis().del(redisKey.tenantConfig(TENANT)).catch(() => undefined);

  console.log(`[POS-BACKFILL] ${config.slug} is now on the native POS adapter`);
}

run().catch(err => { console.error('[POS-BACKFILL] failed:', err); process.exit(1); });
