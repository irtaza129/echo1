import * as db from './supabaseAdmin.js';
import { normStr, type MenuData } from './localMenuUtils.js';

// Writes the admin panel's menu straight into the shared Postgres `categories`,
// `sub_categories` and `dishes` tables — the same tables fetchPosMenu() reads.
//
// Why this exists
// ---------------
// POST /api/admin/menu used to persist the menu to Redis (`menu:data:<id>`) and
// then POST it to the Render/FastAPI backend, which wrote these very rows on our
// behalf. That round trip is best-effort: the route reports `syncOk: false` and
// carries on when Render is cold-starting or down. For a `managed` tenant that
// is fine — Render is their backend either way. For a tenant running our own POS
// it means the menu their till reads can silently be an hour stale, or absent.
//
// A native POS tenant must not need an external service to know what it sells.
//
// Ids come from the database, not from us — but only since migration 019
// ----------------------------------------------------------------------
// REQUIRES migrations/019_menu_id_sequences.sql. Without it every insert below
// fails and adding a menu item does nothing.
//
// This header used to claim these tables "each own an identity sequence
// (`categories_id_seq` and friends), verified against the live database". That
// was wrong, and it had never been verified. The live columns were
// `int4 NOT NULL` with NO default — their ids are large scraped values from the
// original menu import (max dishes.id = 2468438), and no sequence existed.
//
// So every INSERT here failed on a not-null violation, for every tenant, for the
// whole life of this module: ADDING a menu item never worked. Renaming,
// repricing and retiring all go through UPDATE, which was unaffected — which is
// exactly why it looked like a working feature.
//
// Migration 019 creates the sequences and sets each one past max(id), so the
// insert-without-an-id below now does what this comment always claimed. It also
// fixes the same bug in the FastAPI service, which never assigned an id either.
//
// The corollary the old comment got right, for the wrong reason: once a default
// exists, an explicit id does NOT advance the sequence, so any caller that still
// supplies one walks the sequence toward a collision. scripts/backfill-pos.ts
// was that caller and no longer supplies ids.
//
// `dishes.sub_category_id` is NOT NULL while the admin panel's menu model has no
// sub-category concept, so each category gets one catch-all sub-category, reused
// on every later save.
//
// Deletes are SOFT
// ----------------
// `order_items.dish_id` references these rows, and last month's receipt still
// has to render. Removing an item in the admin panel sets `status = 0`, which
// hides it from fetchPosMenu (it filters `status=eq.1`) while leaving history
// intact. Re-adding an item with the same name revives the original row, so its
// historical lines stay connected rather than forking onto a new id.

interface CategoryRow { id: number; name: string; status: number; priority: number }
interface SubCatRow   { id: number; category_id: number; name: string; status: number }
interface DishRow     { id: number; category_id: number; name: string; status: number }

export interface MenuSyncResult {
  categoriesCreated: number;
  categoriesUpdated: number;
  categoriesRetired: number;
  dishesCreated:     number;
  dishesUpdated:     number;
  dishesRetired:     number;
}

/**
 * Reconcile `menu` into Postgres for one tenant. Idempotent.
 *
 * Matching is by normalised name within the tenant, not by id: the admin panel
 * mints its own client-side string ids (`cat_17…`) which have no relationship to
 * the integer primary keys these tables use, and a tenant renaming "Cold Drinks"
 * to "Drinks" is indistinguishable from a delete-plus-create either way.
 *
 * Not transactional — PostgREST has no multi-statement transaction. A crash
 * mid-way leaves a partially-updated menu, which is visible and re-runnable.
 */
export async function syncMenuToPostgres(
  tenantId: string,
  menu: MenuData,
): Promise<MenuSyncResult> {
  const result: MenuSyncResult = {
    categoriesCreated: 0, categoriesUpdated: 0, categoriesRetired: 0,
    dishesCreated:     0, dishesUpdated:     0, dishesRetired:     0,
  };

  // Read every row regardless of status — a retired row must be revived rather
  // than duplicated when the same name comes back.
  const [existingCats, existingSubs, existingDishes] = await Promise.all([
    db.selectMany<CategoryRow>('categories', {
      tenant_id: `eq.${tenantId}`, select: 'id,name,status,priority',
    }),
    db.selectMany<SubCatRow>('sub_categories', {
      tenant_id: `eq.${tenantId}`, select: 'id,category_id,name,status',
    }),
    db.selectMany<DishRow>('dishes', {
      tenant_id: `eq.${tenantId}`, select: 'id,category_id,name,status',
    }),
  ]);

  const catByName  = new Map(existingCats.map(c => [normStr(c.name), c]));
  const dishByName = new Map(existingDishes.map(d => [normStr(d.name), d]));
  const subByCat   = new Map(existingSubs.map(s => [s.category_id, s]));

  // ── Categories ─────────────────────────────────────────────────────────────
  // The admin panel's client-side string id → the Postgres integer ids, so
  // dishes below can resolve both category_id and sub_category_id.
  const catIdByClientId = new Map<string, number>();
  const subIdByClientId = new Map<string, number>();
  const seenCatIds      = new Set<number>();

  for (const [idx, cat] of menu.categories.entries()) {
    const key  = normStr(cat.name);
    const name = cat.name.trim();
    if (!key) continue;                       // an unnamed category is not a category

    // The admin panel orders categories by array position; `priority` sorts
    // descending in fetchPosMenu, so invert to preserve the author's order.
    const priority = menu.categories.length - idx;
    const existing = catByName.get(key);

    let categoryId: number;

    if (existing) {
      categoryId = existing.id;
      if (existing.status !== 1 || existing.priority !== priority) {
        await db.update('categories', { id: `eq.${existing.id}`, tenant_id: `eq.${tenantId}` },
          { status: 1, priority });
        result.categoriesUpdated++;
      }
    } else {
      const row = await db.insertReturning<CategoryRow>('categories', {
        tenant_id: tenantId, name, status: 1, priority,
      });
      categoryId = row.id;
      catByName.set(key, row);
      result.categoriesCreated++;
    }

    // Every dish needs a sub_category_id. Reuse this category's existing one, or
    // mint a single catch-all named after the category.
    let subId = subByCat.get(categoryId)?.id;
    if (subId === undefined) {
      const sub = await db.insertReturning<SubCatRow>('sub_categories', {
        tenant_id: tenantId, category_id: categoryId, name, status: 1,
      });
      subId = sub.id;
      subByCat.set(categoryId, sub);
    }

    catIdByClientId.set(cat.id, categoryId);
    subIdByClientId.set(cat.id, subId);
    seenCatIds.add(categoryId);
  }

  // ── Dishes ─────────────────────────────────────────────────────────────────
  const seenDishIds = new Set<number>();

  for (const item of menu.items) {
    const key = normStr(item.name);
    if (!key) continue;

    const categoryId = catIdByClientId.get(item.categoryId);
    const subId      = subIdByClientId.get(item.categoryId);
    if (categoryId === undefined || subId === undefined) {
      // A dish pointing at a category that is not in this payload. Skipping is
      // the honest response: dishes.category_id is NOT NULL, so there is nothing
      // valid to write, and inventing a category here would create a phantom the
      // admin never asked for.
      console.warn(`[MENU] tenant ${tenantId}: dish "${item.name}" references unknown category ${item.categoryId} — skipped`);
      continue;
    }

    // `availability` is the 86-ing flag (temporarily off); `status` is existence.
    const fields = {
      category_id:     categoryId,
      sub_category_id: subId,
      name:            item.name.trim(),
      description:     item.description ?? '',
      price:           item.price,
      base_price:      item.price,
      status:          1,
      availability:    item.available === false ? 0 : 1,
    };

    const existing = dishByName.get(key);
    if (existing) {
      seenDishIds.add(existing.id);
      await db.update('dishes', { id: `eq.${existing.id}`, tenant_id: `eq.${tenantId}` }, fields);
      result.dishesUpdated++;
    } else {
      const row = await db.insertReturning<DishRow>('dishes', { tenant_id: tenantId, ...fields });
      dishByName.set(key, row);
      seenDishIds.add(row.id);
      result.dishesCreated++;
    }
  }

  // ── Retire what the payload dropped ────────────────────────────────────────
  // Only rows that are currently active — re-retiring an already-retired row
  // would inflate the count and write for no reason.
  for (const d of existingDishes) {
    if (d.status === 1 && !seenDishIds.has(d.id)) {
      await db.update('dishes', { id: `eq.${d.id}`, tenant_id: `eq.${tenantId}` }, { status: 0 });
      result.dishesRetired++;
    }
  }

  for (const c of existingCats) {
    if (c.status === 1 && !seenCatIds.has(c.id)) {
      await db.update('categories', { id: `eq.${c.id}`, tenant_id: `eq.${tenantId}` }, { status: 0 });
      result.categoriesRetired++;
    }
  }

  return result;
}
