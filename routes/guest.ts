import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { issueGuestJwt } from '../src/lib/jwt.js';
import { requireGuest } from '../middleware/guest.js';
import { publish } from '../src/lib/posEvents.js';
import { ordersRepo, computeTotals } from '../src/lib/posRepo.js';
import { AdapterFactory } from '../adapter/AdapterFactory.js';
import { parseTenantConfig, type TenantConfig } from '../src/lib/tenantConfig.js';
import { getRedis, redisKey } from '../src/lib/redis.js';
import { tableQrRepo, dineSessionsRepo, serviceRequestsRepo } from '../src/lib/dineRepo.js';
import { PromptBuilder } from '../src/lib/PromptBuilder.js';
import { GoogleGenAI } from '@google/genai';

// Everything a diner's phone is allowed to do.
//
// This router is mounted WITHOUT attachAdapter and WITHOUT requireAuth. It has
// its own gate (requireGuest) because a diner is not a user of the platform:
// they have no account, they last one meal, and they must never be able to
// reach a staff route by holding a token that happens to be valid.
//
// The one rule that governs every handler below: the table and the session come
// from the TOKEN, never from the request. A guest can send whatever body they
// like and it cannot move their order to another table, another session or
// another restaurant, because nothing here reads a table from user input.

export const guestRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadConfig(tenantId: string): Promise<TenantConfig> {
  const cached = await getRedis().get<unknown>(redisKey.tenantConfig(tenantId));
  if (!cached) throw new Error(`[GUEST] no config for tenant ${tenantId}`);
  return parseTenantConfig(cached);
}

function fail(res: Response, err: unknown, fallback: string): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[GUEST]', msg);
  res.status(500).json({ error: fallback });
}

// ── Starting a session ───────────────────────────────────────────────────────

/**
 * POST /api/guest/session   { qrToken, pin }
 *
 * Public by necessity — this is the call that mints the token everything else
 * requires. Rate limited in server.ts.
 */
guestRouter.post('/session', async (req: Request, res: Response) => {
  const parsed = z.object({
    qrToken: z.string().min(8).max(64),
    pin:     z.string().max(8).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid QR code' }); return; }

  try {
    const table = await tableQrRepo.byToken(parsed.data.qrToken);
    // One message for "no such token" and for "wrong PIN". Distinguishing them
    // tells someone with a photographed QR whether the token is still live.
    const reject = () => res.status(401).json({ error: 'That code or PIN is not valid' });

    if (!table) { reject(); return; }
    if (table.status === 'disabled') {
      res.status(403).json({ error: 'This table is not taking orders right now' });
      return;
    }

    const config = await loadConfig(table.tenant_id);
    if (config.channels?.qr?.enabled !== true) {
      res.status(403).json({ error: 'Table ordering is not enabled here' });
      return;
    }

    // requirePin is a per-tenant choice. Off means the QR alone is enough —
    // offered because some venues want zero friction, but it is not the default
    // and it does mean a photographed code can order from anywhere.
    if (config.channels.qr.requirePin !== false) {
      const pin = parsed.data.pin ?? '';
      if (!pin || !(await tableQrRepo.checkPin(table, pin))) { reject(); return; }
    }

    const session = await dineSessionsRepo.joinOrStart(table.tenant_id, table.id);

    const token = issueGuestJwt({
      tenantId:      table.tenant_id,
      slug:          config.slug,
      tableId:       table.id,
      dineSessionId: session.id,
    });

    res.json({
      token,
      table:      { label: table.label, area: table.area },
      restaurant: {
        name:           config.restaurantName,
        currencySymbol: config.businessRules.currencySymbol,
        primaryColor:   config.branding.primaryColor,
        logoUrl:        config.branding.logoUrl,
      },
      session: { id: session.id, openedAt: session.opened_at },
    });
  } catch (err) { fail(res, err, 'Could not start your table session'); }
});

// ── Everything below requires a table session ────────────────────────────────

guestRouter.use(requireGuest);

guestRouter.get('/menu', async (req: Request, res: Response) => {
  const g = req.guest!;
  try {
    const config  = await loadConfig(g.tenantId);
    const adapter = AdapterFactory.create(config, {});
    res.json(await adapter.getMenuForUI());
  } catch (err) { fail(res, err, 'Could not load the menu'); }
});

// ── Cart ─────────────────────────────────────────────────────────────────────
// The cart is keyed on the DINE SESSION, not on a device, so a table of four
// all adding from their own phones build one shared basket.

guestRouter.get('/cart', async (req: Request, res: Response) => {
  const g = req.guest!;
  try {
    const config  = await loadConfig(g.tenantId);
    const adapter = AdapterFactory.create(config, {});
    const items   = await adapter.getCart(g.dineSessionId);

    const totals = computeTotals(
      items.map(i => ({
        dishName:  i.summary ?? i.dish_name,
        quantity:  i.quantity,
        unitPrice: typeof i.unit_price === 'number' ? i.unit_price : Number(i.unit_price) || 0,
      })),
      config.businessRules.gstRate,
      { serviceChargeRate: config.businessRules.pos.serviceChargeRate },
    );

    res.json({ items, totals });
  } catch (err) { fail(res, err, 'Could not load your basket'); }
});

guestRouter.post('/cart/item', async (req: Request, res: Response) => {
  const parsed = z.object({
    dishQuery: z.string().min(1).max(255),
    modifiers: z.array(z.string().max(120)).max(20).optional(),
    quantity:  z.number().int().min(1).max(50).optional(),
    notes:     z.string().max(300).nullish(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const g = req.guest!;
  try {
    const config  = await loadConfig(g.tenantId);
    const adapter = AdapterFactory.create(config, {});
    // Same resolveItem the voice agent calls, so a dish that needs a size is
    // refused identically whether it was tapped or spoken.
    const result  = await adapter.resolveItem({
      sessionId: g.dineSessionId,
      dishQuery: parsed.data.dishQuery,
      modifiers: parsed.data.modifiers,
      quantity:  parsed.data.quantity,
      notes:     parsed.data.notes,
    });
    res.json(result);
  } catch (err) { fail(res, err, 'Could not add that item'); }
});

guestRouter.delete('/cart/item/:cartItemId', async (req: Request, res: Response) => {
  const g = req.guest!;
  try {
    const config  = await loadConfig(g.tenantId);
    const adapter = AdapterFactory.create(config, {});
    await adapter.removeItem(g.dineSessionId, req.params.cartItemId);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Could not remove that item'); }
});

// ── Placing the order ────────────────────────────────────────────────────────

guestRouter.post('/order', async (req: Request, res: Response) => {
  const parsed = z.object({
    guestName: z.string().max(120).optional(),
    notes:     z.string().max(500).nullish(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const g = req.guest!;
  try {
    const config  = await loadConfig(g.tenantId);
    const adapter = AdapterFactory.create(config, {});

    if (parsed.data.guestName) {
      await dineSessionsRepo.setGuestName(g.tenantId, g.dineSessionId, parsed.data.guestName)
        .catch(() => undefined);
    }

    // orderType and tableId come from the session, never the request. A diner
    // cannot turn their dine-in order into a delivery, or send it to table 3.
    const result = await adapter.submitOrder({
      sessionId:    g.dineSessionId,
      customerName: parsed.data.guestName ?? 'Table guest',
      orderType:    'dine_in',
      notes:        parsed.data.notes,
      source:       'qr',
      tableId:      g.tableId,
    });

    if (result.error) { res.status(400).json({ error: result.error }); return; }

    // Tie the order to the visit, and mark the table occupied. Both are
    // best-effort: the sale is already recorded and must not be undone by a
    // failure to decorate it.
    if (result.order_id) {
      await ordersRepo.setDineSession(g.tenantId, result.order_id, g.dineSessionId)
        .catch(err => console.warn('[GUEST] could not link dine session:', err));
    }

    publish(g.tenantId, 'order.created', {
      orderId:     result.order_id,
      orderNumber: result.order_number,
      tableId:     g.tableId,
      orderType:   'dine_in',
      total:       result.total,
      source:      'qr',
    });
    publish(g.tenantId, 'table.status', { tableId: g.tableId, status: 'occupied' });

    res.status(201).json({
      orderId:     result.order_id,
      orderNumber: result.order_number,
      total:       result.total,
    });
  } catch (err) { fail(res, err, 'Could not send your order'); }
});

/** Order tracking. Scoped to this session — a guest cannot read another table's order. */
guestRouter.get('/order/:orderId/status', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.orderId)) { res.status(400).json({ error: 'Invalid order' }); return; }

  const g = req.guest!;
  try {
    const order = await ordersRepo.findById(g.tenantId, req.params.orderId);
    // Checking the dine session, not just the tenant: same restaurant is not
    // close enough, or table 3 could read table 7's bill by guessing a uuid.
    if (!order || (order as { dine_session_id?: string }).dine_session_id !== g.dineSessionId) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const items = await ordersRepo.items(order.id);
    res.json({
      orderNumber: order.order_number,
      status:      order.status,
      placedAt:    order.created_at,
      total:       Number(order.total_amount),
      items: items.filter(i => !i.voided_at).map(i => ({
        name:     i.dish_name,
        quantity: i.quantity,
      })),
    });
  } catch (err) { fail(res, err, 'Could not check your order'); }
});

guestRouter.get('/orders', async (req: Request, res: Response) => {
  const g = req.guest!;
  try {
    const orders = await ordersRepo.forDineSession(g.tenantId, g.dineSessionId);
    res.json(orders.map(o => ({
      orderId:     o.id,
      orderNumber: o.order_number,
      status:      o.status,
      placedAt:    o.created_at,
      total:       Number(o.total_amount),
    })));
  } catch (err) { fail(res, err, 'Could not load your orders'); }
});

// ── Calling a waiter ─────────────────────────────────────────────────────────

guestRouter.post('/service-request', async (req: Request, res: Response) => {
  const parsed = z.object({
    type: z.enum(['call_waiter', 'request_bill', 'water', 'assistance']).default('call_waiter'),
    note: z.string().max(280).nullish(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const g = req.guest!;
  try {
    const config   = await loadConfig(g.tenantId);
    const cooldown = config.channels?.qr?.waiterCooldown ?? 60;

    // Cooldown is enforced here, not in the button. A bored child tapping "call
    // waiter" forty times must not produce forty alerts on the cashier's
    // screen, and a client-side timer is one refresh away from being reset.
    const latest = await serviceRequestsRepo.latestForTable(g.tenantId, g.tableId);
    if (latest && latest.status === 'open') {
      const age = (Date.now() - new Date(latest.created_at).getTime()) / 1000;
      if (age < cooldown) {
        res.status(429).json({
          error: 'Someone is already on their way to your table.',
          retryAfter: Math.ceil(cooldown - age),
        });
        return;
      }
    }

    const request = await serviceRequestsRepo.create({
      tenantId:      g.tenantId,
      tableId:       g.tableId,
      dineSessionId: g.dineSessionId,
      type:          parsed.data.type,
      note:          parsed.data.note,
    });

    const table = await tableQrRepo.byId(g.tenantId, g.tableId);

    // The label, not the uuid: the alert has to say "Table 6" to be useful to
    // someone carrying plates.
    publish(g.tenantId, 'service_request.created', {
      requestId:  request.id,
      tableId:    g.tableId,
      tableLabel: table?.label ?? '?',
      area:       table?.area  ?? '',
      type:       request.type,
      note:       request.note,
      createdAt:  request.created_at,
    });

    res.status(201).json({ ok: true, requestId: request.id, cooldown });
  } catch (err) { fail(res, err, 'Could not call a waiter'); }
});

// ── Voice ──────────────────────────────────────────────────────────────
// The diner talks to the same Gemini Live agent the kiosk uses. Two things
// are handled here rather than in the browser:
//
//   1. The API key. The phone gets a 60-second ephemeral token, exactly like
//      the kiosk — the real key never leaves this process. A diner's phone is
//      the least trusted device that will ever touch this system.
//   2. The system prompt. Built server-side so the table, the menu and the
//      'this is dine-in, never ask about payment' rules cannot be edited by
//      whoever is holding the phone.

guestRouter.post('/voice/session', async (req: Request, res: Response) => {
  const g = req.guest!;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[GUEST] GEMINI_API_KEY is not set — voice ordering is unavailable');
    res.status(503).json({ error: 'Voice ordering is not available right now' });
    return;
  }

  try {
    const config = await loadConfig(g.tenantId);
    const table  = await tableQrRepo.byId(g.tenantId, g.tableId);

    const adapter     = AdapterFactory.create(config, {});
    const menuContext = await adapter.getMenuContext();

    const systemInstruction = PromptBuilder.build({
      restaurantName: config.restaurantName,
      gemini:         config.gemini,
      businessRules:  { gstRate: config.businessRules.gstRate },
      channel:        'qr',
      tableLabel:     table?.label,
      // A diner never pays through this channel — a waiter settles the bill at
      // the end — so the agent must never raise it.
      acceptsCard:    false,
    }, menuContext);

    // Same call the kiosk's /api/gemini-token makes — a 60-second, single-use
    // token. The real key never reaches the phone.
    const ai    = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
    const token = await ai.authTokens.create({});
    if (!token.name) throw new Error('SDK returned no token name');

    res.json({
      token: token.name,
      model: config.gemini.modelOverride ?? 'gemini-3.1-flash-live-preview',
      voice: config.gemini.voice,
      systemInstruction,
    });
  } catch (err) {
    // Voice failing must never block the tap-to-order path — the guest app
    // falls back to the menu list and says so.
    console.error('[GUEST] voice session failed:', err);
    res.status(503).json({ error: 'Voice ordering is not available right now' });
  }
});

// clear_cart, for the voice agent's tool of the same name.
guestRouter.delete('/cart', async (req: Request, res: Response) => {
  const g = req.guest!;
  try {
    const config  = await loadConfig(g.tenantId);
    const adapter = AdapterFactory.create(config, {});
    await adapter.clearCart(g.dineSessionId);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Could not clear your basket'); }
});
