import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  ordersRepo, paymentsRepo, shiftsRepo, tablesRepo, customersRepo,
  computeTotals, type NewOrderItem,
} from '../src/lib/posRepo.js';
import { auditRepo, tenantConfigsRepo, dualWrite } from '../src/lib/repo.js';
import { getRedis, redisKey, TTL } from '../src/lib/redis.js';
import { parseTenantConfig, type TenantConfig } from '../src/lib/tenantConfig.js';
import { toWireOrder, PosAdapter } from '../adapter/PosAdapter.js';
import { publish } from '../src/lib/posEvents.js';
import { serviceRequestsRepo, tableQrRepo, dineSessionsRepo } from '../src/lib/dineRepo.js';
import { buildReceipt, buildKitchenTicket } from '../src/lib/escpos.js';
import { printRaw, parsePrinterConfig } from '../src/lib/printer.js';
import { kdsRepo } from '../src/lib/kdsRepo.js';
import { reportsRepo, toCsv } from '../src/lib/reportsRepo.js';
import QRCode from 'qrcode';
import { hashPin, isValidPinFormat, isWeakPin } from '../src/lib/pin.js';
import {
  identifyByPin, checkLockout, recordFailure, clearFailures,
  findOrProvision, setPin, clearPin, setPermissions, listStaff, normalisePermissions,
  type PosPermissions,
} from '../src/lib/staffRepo.js';

// Point-of-sale routes. Mounted in server.ts behind:
//   requireAuth → attachAdapter → requireFeature('pos')
// so every handler here can assume an authenticated caller, a resolved
// req.tenantConfig, and a tenant entitled to the POS module.
//
// These are deliberately NOT on IRestaurantAdapter. Tendering cash, closing a
// drawer and transferring a table are meaningless for `managed` and
// `custom_api` tenants, and forcing those adapters to stub them would be
// dishonest typing — the interface would claim capabilities that throw.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Money arriving from a browser: reject NaN/Infinity/negatives at the edge so
// they can never reach a numeric column or a total.
const money = z.number().finite().nonnegative();

interface Ctx { tenantId: string; actor: string }

function ctx(req: Request): Ctx {
  return {
    tenantId: req.tenantConfig!.tenantId,
    actor:    req.jwtPayload?.sub ?? 'unknown',
  };
}

// Audit writes are awaited (not fire-and-forget) so a void or refund is on
// record before we answer. But a failed audit must not fail the response: the
// money has already moved, and a non-2xx here would invite the client to retry
// and refund twice. Log loudly instead.
async function auditPos(c: Ctx, action: string, details?: string): Promise<void> {
  try {
    await auditRepo.append({ tenantId: c.tenantId, actor: c.actor, action, details });
  } catch (err) {
    console.error(`[POS] AUDIT WRITE FAILED — ${action} by ${c.actor}:`, err);
  }
}

// One place to turn a thrown repo error into a response. Repo functions throw
// on constraint violations (over-refund, duplicate open shift, double booking),
// which are client errors, not server faults.
function fail(res: Response, err: unknown, fallback = 'Request failed'): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[POS]', msg);
  if (/exceeds|not found|empty|refusing/i.test(msg)) {
    res.status(400).json({ error: msg });
    return;
  }
  res.status(500).json({ error: fallback });
}

export const posRouter = Router();

// ── Tables ───────────────────────────────────────────────────────────────────

// ── Menu ─────────────────────────────────────────────────────────────────────
// The Till NEVER reads the menu through req.adapter.
//
// It creates orders by calling posRepo directly (see /orders below), so every
// Till sale lands in our own Postgres regardless of what adapter.type a tenant
// has configured for their voice channels. If the menu the cashier taps came
// from a DIFFERENT source — the Render backend, a tenant's own API — its dish
// ids would not even be numbers from OUR dishes table, and the browser has no
// way to tell the two apart.
//
// This bit a real tenant: enabling the Till (features.pos) without also
// switching adapter.type to 'pos' left /api/menu returning a foreign shape with
// no dish_id at all. Every tap then collided on the same "no id" signature in
// OrderEntry.tsx and silently incremented whatever line was added first —
// tapping Pizza added to the Drinks line. A brand new PosAdapter instance,
// independent of req.adapter, is what makes that impossible: this route always
// reads OUR dishes table, so the ids the Till hands back to itself are always
// real.
posRouter.get('/menu', async (req: Request, res: Response) => {
  try {
    const adapter = new PosAdapter(req.tenantConfig!);
    res.json(await adapter.getMenuForUI());
  } catch (err) { fail(res, err, 'Failed to load the menu'); }
});

posRouter.get('/tables', async (req: Request, res: Response) => {
  try {
    res.json(await tablesRepo.list(ctx(req).tenantId));
  } catch (err) { fail(res, err, 'Failed to load tables'); }
});

const TableBody = z.object({
  area:  z.string().max(64).optional(),
  label: z.string().min(1).max(64),
  seats: z.number().int().min(1).max(64).optional(),
  x:     z.number().int().optional(),
  y:     z.number().int().optional(),
});

posRouter.post('/tables', async (req: Request, res: Response) => {
  const parsed = TableBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    res.status(201).json(await tablesRepo.create({ tenantId: ctx(req).tenantId, ...parsed.data }));
  } catch (err) { fail(res, err, 'Failed to create table'); }
});

posRouter.patch('/tables/:id', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid table id' }); return; }
  const parsed = TableBody.partial().extend({
    status: z.enum(['available', 'occupied', 'reserved', 'disabled']).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    await tablesRepo.update(ctx(req).tenantId, req.params.id, parsed.data);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to update table'); }
});

posRouter.delete('/tables/:id', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid table id' }); return; }
  try {
    await tablesRepo.remove(ctx(req).tenantId, req.params.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to delete table'); }
});

// ── Orders ───────────────────────────────────────────────────────────────────

const OrderItemBody = z.object({
  dishId:    z.number().int().optional(),
  dishName:  z.string().min(1).max(255),
  quantity:  z.number().int().min(1).max(999),
  unitPrice: money,
  lineDiscount: money.optional(),
  selectedOptions: z.array(z.object({
    option_name: z.string().optional(),
    choice_name: z.string(),
  })).optional(),
  notes:  z.string().max(500).nullish(),
  seatNo: z.number().int().min(1).max(99).nullish(),
  course: z.string().max(32).nullish(),
});

const CreateOrderBody = z.object({
  items:         z.array(OrderItemBody).min(1),
  orderType:     z.string().max(32).optional(),
  tableId:       z.string().regex(UUID_RE).nullish(),
  customerId:    z.string().regex(UUID_RE).nullish(),
  customerName:  z.string().max(255).optional(),
  customerPhone: z.string().max(32).optional(),
  discount:      money.optional(),
  deliveryFee:   money.optional(),
  notes:         z.string().max(1000).nullish(),
  status:        z.string().max(32).optional(),
});

posRouter.post('/orders', async (req: Request, res: Response) => {
  const parsed = CreateOrderBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const c   = ctx(req);
  const cfg = req.tenantConfig!;

  try {
    // Attach the open shift automatically. A sale that isn't part of a shift
    // never appears in that shift's cash reconciliation, and expecting the
    // till operator to pass a shift id from the browser is how that goes wrong.
    const shift = await shiftsRepo.current(c.tenantId);

    const { order, totals } = await ordersRepo.create({
      tenantId:          c.tenantId,
      items:             parsed.data.items as NewOrderItem[],
      gstRate:           cfg.businessRules.gstRate,
      serviceChargeRate: cfg.businessRules.pos.serviceChargeRate,
      discount:          parsed.data.discount,
      deliveryFee:       parsed.data.deliveryFee,
      customerName:      parsed.data.customerName,
      customerPhone:     parsed.data.customerPhone,
      customerId:        parsed.data.customerId,
      orderType:         parsed.data.orderType ?? 'dine_in',
      tableId:           parsed.data.tableId,
      shiftId:           shift?.id ?? null,
      notes:             parsed.data.notes,
      status:            parsed.data.status ?? 'pending',
      source:            'pos',
    });

    if (parsed.data.tableId) {
      await tablesRepo.update(c.tenantId, parsed.data.tableId, { status: 'occupied' })
        .catch(() => undefined);
    }

    await auditPos(c, 'pos.order.create', `#${order.order_number} total ${totals.total}`);

    // Tell every connected terminal before answering the caller. publish() is
    // synchronous and never throws, so this cannot turn a committed sale into
    // a failed request.
    publish(c.tenantId, 'order.created', {
      orderId: order.id, orderNumber: order.order_number,
      tableId: order.table_id, orderType: order.order_type,
      total: totals.total, source: 'pos',
    });
    if (parsed.data.tableId) {
      publish(c.tenantId, 'table.status', { tableId: parsed.data.tableId, status: 'occupied' });
    }

    res.status(201).json({ order, totals });
  } catch (err) { fail(res, err, 'Failed to create order'); }
});

posRouter.get('/orders/:id', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid order id' }); return; }
  const c = ctx(req);
  try {
    const order = await ordersRepo.findById(c.tenantId, req.params.id);
    if (!order) { res.status(404).json({ error: 'Order not found' }); return; }

    const [items, payments] = await Promise.all([
      ordersRepo.items(order.id),
      paymentsRepo.forOrder(order.id),
    ]);

    res.json({ order, items, payments, wire: toWireOrder(order, items) });
  } catch (err) { fail(res, err, 'Failed to load order'); }
});

posRouter.post('/orders/:id/void', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid order id' }); return; }
  const parsed = z.object({ reason: z.string().min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A void reason is required' }); return; }

  const c = ctx(req);
  try {
    const order = await ordersRepo.findById(c.tenantId, req.params.id);
    if (!order) { res.status(404).json({ error: 'Order not found' }); return; }

    // Voiding an order that has already taken money would strand that money:
    // the payment stays captured while the order reads as never sold. Refund
    // the tender first, then void.
    const paid = await paymentsRepo.paidTotal(order.id);
    if (paid > 0) {
      res.status(400).json({
        error: `Order has ${paid} in captured payments — refund them before voiding`,
      });
      return;
    }

    await ordersRepo.void(c.tenantId, order.id, parsed.data.reason);
    if (order.table_id) {
      await tablesRepo.update(c.tenantId, order.table_id, { status: 'available' }).catch(() => undefined);
    }

    await auditPos(c, 'pos.order.void', `#${order.order_number}: ${parsed.data.reason}`);
    publish(c.tenantId, 'order.voided', {
      orderId: order.id, orderNumber: order.order_number, reason: parsed.data.reason,
    });
    if (order.table_id) {
      publish(c.tenantId, 'table.status', { tableId: order.table_id, status: 'available' });
    }
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to void order'); }
});

posRouter.post('/orders/:id/transfer', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid order id' }); return; }
  const parsed = z.object({ tableId: z.string().regex(UUID_RE).nullable() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const c = ctx(req);
  try {
    const order = await ordersRepo.findById(c.tenantId, req.params.id);
    if (!order) { res.status(404).json({ error: 'Order not found' }); return; }

    await ordersRepo.transferTable(c.tenantId, order.id, parsed.data.tableId);

    // Free the old table, occupy the new one. Best-effort: the table's status
    // is a display convenience, and the order's table_id is the real record.
    if (order.table_id) {
      await tablesRepo.update(c.tenantId, order.table_id, { status: 'available' }).catch(() => undefined);
    }
    if (parsed.data.tableId) {
      await tablesRepo.update(c.tenantId, parsed.data.tableId, { status: 'occupied' }).catch(() => undefined);
    }

    await auditPos(c, 'pos.order.transfer', `#${order.order_number} → table ${parsed.data.tableId ?? 'none'}`);
    publish(c.tenantId, 'order.transferred', {
      orderId: order.id, orderNumber: order.order_number,
      fromTableId: order.table_id, toTableId: parsed.data.tableId,
    });
    if (order.table_id)      publish(c.tenantId, 'table.status', { tableId: order.table_id,      status: 'available' });
    if (parsed.data.tableId) publish(c.tenantId, 'table.status', { tableId: parsed.data.tableId, status: 'occupied'  });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to transfer order'); }
});

// ── Payments ─────────────────────────────────────────────────────────────────

const PaymentBody = z.object({
  method:    z.enum(['cash', 'card', 'wallet', 'bank', 'voucher', 'other']),
  amount:    money.positive(),
  tendered:  money.optional(),
  tip:       money.optional(),
  reference: z.string().max(128).nullish(),
});

posRouter.post('/orders/:id/payments', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid order id' }); return; }
  const parsed = PaymentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const c = ctx(req);
  const { method, amount, tendered, tip, reference } = parsed.data;

  try {
    const order = await ordersRepo.findById(c.tenantId, req.params.id);
    if (!order)          { res.status(404).json({ error: 'Order not found' }); return; }
    if (order.voided_at) { res.status(400).json({ error: 'Cannot take payment on a voided order' }); return; }

    // Over-tender check lives here, not in the UI. Two terminals paying the
    // same tab would each see "nothing paid yet" client-side.
    const total = Number(order.total_amount);
    const paid  = await paymentsRepo.paidTotal(order.id);
    const due   = Math.round((total - paid) * 100) / 100;

    if (amount > due + 0.001) {
      res.status(400).json({ error: `Payment ${amount} exceeds the ${due} still due`, due });
      return;
    }

    // Change is only ever given on cash. Handing back "change" on a card
    // payment is a cash-drawer leak, so it is not representable here.
    const changeDue = method === 'cash' && tendered && tendered > amount
      ? Math.round((tendered - amount) * 100) / 100
      : 0;

    const shift   = await shiftsRepo.current(c.tenantId);
    const payment = await paymentsRepo.capture({
      tenantId: c.tenantId, orderId: order.id, shiftId: shift?.id ?? null,
      method, amount, tendered, changeDue, tip, reference,
    });

    const nowPaid = Math.round((paid + amount) * 100) / 100;
    const settled = nowPaid >= total - 0.001;

    if (settled) {
      await ordersRepo.close(c.tenantId, order.id);
      if (order.table_id) {
        await tablesRepo.update(c.tenantId, order.table_id, { status: 'available' }).catch(() => undefined);
      }
    }

    await auditPos(c, 'pos.payment.capture', `#${order.order_number} ${method} ${amount}`);
    publish(c.tenantId, 'order.paid', {
      orderId: order.id, orderNumber: order.order_number,
      method, amount, paid: nowPaid, due: Math.round((total - nowPaid) * 100) / 100, settled,
    });
    if (settled && order.table_id) {
      publish(c.tenantId, 'table.status', { tableId: order.table_id, status: 'available' });
    }
    res.status(201).json({ payment, paid: nowPaid, due: Math.round((total - nowPaid) * 100) / 100, settled });
  } catch (err) { fail(res, err, 'Failed to record payment'); }
});

posRouter.post('/payments/:id/refund', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid payment id' }); return; }
  const parsed = z.object({
    amount: money.positive(),
    reason: z.string().min(1).max(500),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A refund amount and reason are required' }); return; }

  const c = ctx(req);
  try {
    const payment = await paymentsRepo.refund(c.tenantId, req.params.id, parsed.data.amount);
    await auditPos(c, 'pos.payment.refund', `${parsed.data.amount} on payment ${req.params.id}: ${parsed.data.reason}`);
    res.json({ payment });
  } catch (err) { fail(res, err, 'Failed to refund payment'); }
});

// ── Shifts ───────────────────────────────────────────────────────────────────

posRouter.get('/shifts/current', async (req: Request, res: Response) => {
  const c = ctx(req);
  try {
    const shift = await shiftsRepo.current(c.tenantId);
    if (!shift) { res.json({ shift: null }); return; }

    const [expected, movements, openOrders] = await Promise.all([
      shiftsRepo.expectedCash(c.tenantId, shift),
      shiftsRepo.movements(shift.id),
      shiftsRepo.openOrderCount(c.tenantId, shift.id),
    ]);

    res.json({ shift, expectedCash: expected, movements, openOrders });
  } catch (err) { fail(res, err, 'Failed to load shift'); }
});

posRouter.post('/shifts/open', async (req: Request, res: Response) => {
  const parsed = z.object({ openingFloat: money }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'openingFloat is required' }); return; }

  const c = ctx(req);
  try {
    const existing = await shiftsRepo.current(c.tenantId);
    if (existing) { res.status(409).json({ error: 'A shift is already open', shift: existing }); return; }

    const shift = await shiftsRepo.open(c.tenantId, null, parsed.data.openingFloat);
    await auditPos(c, 'pos.shift.open', `float ${parsed.data.openingFloat}`);
    publish(c.tenantId, 'shift.opened', { shiftId: shift.id, openingFloat: parsed.data.openingFloat });
    res.status(201).json({ shift });
  } catch (err) {
    // A unique-violation here means another manager won the race between the
    // check above and this insert — the partial index did its job.
    fail(res, err, 'Failed to open shift');
  }
});

posRouter.post('/shifts/:id/cash-movement', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid shift id' }); return; }
  const parsed = z.object({
    type:   z.enum(['cash_in', 'cash_out', 'drop', 'pickup']),
    amount: money.positive(),
    reason: z.string().max(500).nullish(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const c = ctx(req);
  try {
    const shift = await shiftsRepo.current(c.tenantId);
    if (!shift || shift.id !== req.params.id) {
      res.status(400).json({ error: 'Shift is not open' }); return;
    }

    const movement = await shiftsRepo.addMovement({
      tenantId: c.tenantId, shiftId: shift.id, ...parsed.data,
    });
    await auditPos(c, 'pos.shift.cash_movement', `${parsed.data.type} ${parsed.data.amount}`);
    res.status(201).json({ movement });
  } catch (err) { fail(res, err, 'Failed to record cash movement'); }
});

posRouter.post('/shifts/:id/close', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid shift id' }); return; }
  const parsed = z.object({
    declaredCash: money,
    note:         z.string().max(500).nullish(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'declaredCash is required' }); return; }

  const c = ctx(req);
  try {
    const shift = await shiftsRepo.current(c.tenantId);
    if (!shift || shift.id !== req.params.id) {
      res.status(400).json({ error: 'Shift is not open' }); return;
    }

    // Refuse to close over open tabs. Their eventual payments would land
    // against a closed shift, and the variance recorded tonight would be
    // wrong the moment table 6 finally pays.
    const open = await shiftsRepo.openOrderCount(c.tenantId, shift.id);
    if (open > 0) {
      res.status(400).json({ error: `${open} order(s) still open — settle or void them before closing`, openOrders: open });
      return;
    }

    const closed = await shiftsRepo.close(c.tenantId, shift, parsed.data.declaredCash, null, parsed.data.note);
    await auditPos(c, 'pos.shift.close',
      `declared ${closed.declared_cash} expected ${closed.expected_cash} variance ${closed.variance}`);
    publish(c.tenantId, 'shift.closed', {
      shiftId: closed.id, declaredCash: closed.declared_cash,
      expectedCash: closed.expected_cash, variance: closed.variance,
    });
    res.json({ shift: closed });
  } catch (err) { fail(res, err, 'Failed to close shift'); }
});

// ── Customers ────────────────────────────────────────────────────────────────

posRouter.get('/customers', async (req: Request, res: Response) => {
  const phone = typeof req.query.phone === 'string' ? req.query.phone.trim() : '';
  if (!phone) { res.status(400).json({ error: 'phone query parameter is required' }); return; }
  try {
    res.json({ customer: await customersRepo.findByPhone(ctx(req).tenantId, phone) });
  } catch (err) { fail(res, err, 'Failed to look up customer'); }
});

posRouter.post('/customers', async (req: Request, res: Response) => {
  const parsed = z.object({
    name:  z.string().max(255).optional(),
    phone: z.string().min(3).max(32),
    email: z.string().email().optional(),
    notes: z.string().max(1000).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  try {
    const customer = await customersRepo.findOrCreate(
      ctx(req).tenantId, parsed.data.phone, parsed.data.name,
    );
    res.status(201).json({ customer });
  } catch (err) { fail(res, err, 'Failed to save customer'); }
});

// ── Quote ────────────────────────────────────────────────────────────────────
// Server-authoritative totals for a basket that has not been saved yet. The POS
// uses it to show tax and service charge before the order exists, without
// reimplementing computeTotals in the browser and drifting from it.

posRouter.post('/quote', (req: Request, res: Response) => {
  const parsed = z.object({
    items:    z.array(OrderItemBody).min(1),
    discount: money.optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const cfg = req.tenantConfig!;
  res.json(computeTotals(parsed.data.items as NewOrderItem[], cfg.businessRules.gstRate, {
    discount:          parsed.data.discount,
    serviceChargeRate: cfg.businessRules.pos.serviceChargeRate,
  }));
});


// ── Staff PIN ────────────────────────────────────────────────────────────────
// The terminal is authenticated as the tenant for the whole shift (requireAuth,
// above). These routes identify WHICH member of staff is acting, which is what
// makes staff_id on an order and approved-by on a void meaningful.
//
// A PIN is not a password and is never treated as one: it does not grant a
// session, it does not widen tenant access, and it cannot reach anything the
// terminal's own token could not already reach.

posRouter.post('/pin-login', async (req: Request, res: Response) => {
  const parsed = z.object({ pin: z.string().min(4).max(8) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A PIN is required' }); return; }

  const c = ctx(req);

  // Lockout is checked BEFORE the hash comparison. Doing it after would let an
  // attacker keep spending our scrypt budget while locked out, turning the
  // lockout into a self-inflicted denial of service.
  const lock = await checkLockout(c.tenantId);
  if (lock.locked) {
    res.status(429).json({ error: 'Too many incorrect PINs. Wait a minute and try again.' });
    return;
  }

  try {
    const staff = await identifyByPin(c.tenantId, parsed.data.pin);

    if (!staff) {
      await recordFailure(c.tenantId);
      const after = await checkLockout(c.tenantId);
      // The remaining count is deliberately vague about WHY a PIN failed — it
      // never says whether that PIN belongs to nobody or to someone without
      // POS access.
      res.status(401).json({ error: 'PIN not recognised', attemptsRemaining: after.remaining });
      return;
    }

    await clearFailures(c.tenantId);
    await auditPos(c, 'pos.pin.login', `${staff.email}`);

    res.json({
      staffId:     staff.staffId,
      email:       staff.email,
      role:        staff.role,
      permissions: staff.permissions,
    });
  } catch (err) { fail(res, err, 'PIN check failed'); }
});

// Managing PINs and permissions is an admin action, not a till action.
function requireAdmin(req: Request, res: Response): boolean {
  const role = req.jwtPayload?.role;
  if (role !== 'tenant_admin' && role !== 'super_admin') {
    res.status(403).json({ error: 'Only an account admin can manage staff PINs' });
    return false;
  }
  return true;
}

posRouter.get('/staff', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    res.json({ staff: await listStaff(ctx(req).tenantId) });
  } catch (err) { fail(res, err, 'Failed to load staff'); }
});

posRouter.put('/staff/:email/pin', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const parsed = z.object({ pin: z.string() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A PIN is required' }); return; }

  const pin = parsed.data.pin.trim();
  if (!isValidPinFormat(pin)) {
    res.status(400).json({ error: 'A PIN must be 4 to 8 digits' }); return;
  }
  if (isWeakPin(pin)) {
    res.status(400).json({
      error: 'That PIN is too easy to guess. Avoid repeated digits and simple runs like 1234.',
    });
    return;
  }

  const c     = ctx(req);
  const email = decodeURIComponent(req.params.email);

  try {
    const staff = await findOrProvision(c.tenantId, email);
    if (!staff) { res.status(404).json({ error: 'Staff member not found' }); return; }

    await setPin(c.tenantId, staff.id, await hashPin(pin));
    await auditPos(c, 'pos.pin.set', email);
    res.json({ ok: true });
  } catch (err) {
    // The unique index on (tenant_id, pin_hash) cannot actually collide here —
    // every hash carries its own random salt — so a duplicate-key error would
    // mean something else entirely. Let fail() surface it.
    fail(res, err, 'Failed to set PIN');
  }
});

posRouter.delete('/staff/:email/pin', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const c     = ctx(req);
  const email = decodeURIComponent(req.params.email);

  try {
    const staff = await findOrProvision(c.tenantId, email);
    if (!staff) { res.status(404).json({ error: 'Staff member not found' }); return; }

    await clearPin(c.tenantId, staff.id);
    await auditPos(c, 'pos.pin.clear', email);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to clear PIN'); }
});

posRouter.put('/staff/:email/permissions', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const parsed = z.object({
    can_void:         z.boolean().optional(),
    can_discount:     z.boolean().optional(),
    can_refund:       z.boolean().optional(),
    can_close_shift:  z.boolean().optional(),
    can_open_drawer:  z.boolean().optional(),
    max_discount_pct: z.number().min(0).max(100).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const c     = ctx(req);
  const email = decodeURIComponent(req.params.email);

  try {
    const staff = await findOrProvision(c.tenantId, email);
    if (!staff) { res.status(404).json({ error: 'Staff member not found' }); return; }

    // Normalise rather than storing the request body: an unknown key written
    // straight into the jsonb column would later read as a capability nobody
    // designed, and the column is what every permission check consults.
    const permissions = normalisePermissions(parsed.data);
    await setPermissions(c.tenantId, staff.id, permissions);
    await auditPos(c, 'pos.permissions.set', `${email}: ${JSON.stringify(permissions)}`);
    res.json({ permissions });
  } catch (err) { fail(res, err, 'Failed to update permissions'); }
});

// ── Manager approval ───────────────────────────────────────────────────
// Voids, over-limit discounts and refunds all need someone with authority to
// stand at the till and enter their PIN. The approval is checked HERE, on the
// server, against that person's stored permissions — a client that decides for
// itself whether a manager approved something is not a control, it is a
// suggestion.
//
// The approver is returned so the caller can record WHO authorised it. Every
// privileged route below writes that into the audit trail.

interface Approval { staffId: string; email: string; permissions: PosPermissions }

async function approve(
  req: Request,
  capability: 'can_void' | 'can_discount' | 'can_refund' | 'can_close_shift' | 'can_open_drawer',
): Promise<{ ok: true; by: Approval } | { ok: false; status: number; error: string }> {
  const pin = (req.body as { approvalPin?: unknown }).approvalPin;
  if (typeof pin !== 'string' || pin.length < 4) {
    return { ok: false, status: 401, error: 'A manager PIN is required for this action' };
  }

  const staff = await identifyByPin(req.tenantConfig!.tenantId, pin);
  if (!staff) return { ok: false, status: 401, error: 'PIN not recognised' };

  if (staff.permissions[capability] !== true) {
    return {
      ok: false, status: 403,
      error: `${staff.email} is not allowed to authorise this. Ask a manager.`,
    };
  }

  return { ok: true, by: { staffId: staff.staffId, email: staff.email, permissions: staff.permissions } };
}

// Money rates are read from the tenant's own config on every call rather than
// captured once — a tenant who changes their GST rate must not have it applied
// only to orders created after the next redeploy.
function rates(req: Request) {
  const cfg = req.tenantConfig!;
  return {
    gstRate:           cfg.businessRules.gstRate,
    serviceChargeRate: cfg.businessRules.pos.serviceChargeRate,
  };
}

// ── Amending an open tab ────────────────────────────────────────────────

posRouter.post('/orders/:id/items', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid order id' }); return; }
  const parsed = z.object({ items: z.array(OrderItemBody).min(1) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const c = ctx(req);
  try {
    const { order, totals } = await ordersRepo.addItems(
      c.tenantId, req.params.id, parsed.data.items as NewOrderItem[], rates(req),
    );
    await auditPos(c, 'pos.order.add_items',
      `#${order.order_number} +${parsed.data.items.length} line(s) → ${totals.total}`);
    publish(c.tenantId, 'order.status',
      { orderId: order.id, orderNumber: order.order_number, status: order.status });
    res.status(201).json({ order, totals });
  } catch (err) { fail(res, err, 'Failed to add items'); }
});

posRouter.post('/orders/:id/items/:itemId/void', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.itemId)) {
    res.status(400).json({ error: 'Invalid id' }); return;
  }
  const parsed = z.object({ reason: z.string().min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A void reason is required' }); return; }

  const auth = await approve(req, 'can_void');
  if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }

  const c = ctx(req);
  try {
    // A line cannot be voided down past what has already been tendered: that
    // would leave money attached to a sale that no longer exists. Checked
    // BEFORE the write, so a refusal changes nothing.
    const paid    = await paymentsRepo.paidTotal(req.params.id);
    const preview = await ordersRepo.previewVoidItem(c.tenantId, req.params.id, req.params.itemId, rates(req));

    if (paid > preview.total + 0.001) {
      res.status(400).json({
        error: `Voiding this line drops the total to ${preview.total} but ${paid} has already been taken. Refund the difference first.`,
      });
      return;
    }

    const { order, totals } = await ordersRepo.voidItem(
      c.tenantId, req.params.id, req.params.itemId,
      parsed.data.reason, auth.by.staffId, rates(req),
    );

    await auditPos(c, 'pos.item.void',
      `#${order.order_number} line ${req.params.itemId}: ${parsed.data.reason} (by ${auth.by.email})`);
    publish(c.tenantId, 'order.status',
      { orderId: order.id, orderNumber: order.order_number, status: order.status });
    res.json({ order, totals, approvedBy: auth.by.email });
  } catch (err) { fail(res, err, 'Failed to void line'); }
});

posRouter.post('/orders/:id/discount', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid order id' }); return; }
  const parsed = z.object({
    discount: money,
    reason:   z.string().min(1).max(500),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'A discount amount and reason are required' }); return; }

  const auth = await approve(req, 'can_discount');
  if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }

  const c = ctx(req);
  try {
    const before = await ordersRepo.findById(c.tenantId, req.params.id);
    if (!before) { res.status(404).json({ error: 'Order not found' }); return; }

    // The approver's ceiling is enforced server-side against the order's own
    // subtotal. A till that decides for itself whether a discount is within
    // someone's limit can simply decide that it is. The permissions come from
    // the same lookup that authenticated the PIN, so this costs no extra work.
    const subtotal = Number(before.subtotal);
    const pct      = subtotal > 0 ? (parsed.data.discount / subtotal) * 100 : 100;
    const limit    = auth.by.permissions.max_discount_pct;

    if (pct > limit + 0.001) {
      res.status(403).json({
        error: `That is ${pct.toFixed(1)}% off. ${auth.by.email} can authorise up to ${limit}%.`,
      });
      return;
    }

    // Same rule as voiding a line: never discount below what has been paid.
    const paid    = await paymentsRepo.paidTotal(req.params.id);
    const preview = await ordersRepo.previewDiscount(c.tenantId, req.params.id, parsed.data.discount, rates(req));
    if (paid > preview.total + 0.001) {
      res.status(400).json({
        error: `That discount drops the total to ${preview.total} but ${paid} has already been taken. Refund the difference first.`,
      });
      return;
    }

    const { order, totals } = await ordersRepo.applyDiscount(
      c.tenantId, req.params.id, parsed.data.discount,
      parsed.data.reason, auth.by.staffId, rates(req),
    );

    await auditPos(c, 'pos.order.discount',
      `#${order.order_number} -${parsed.data.discount} (${parsed.data.reason}) by ${auth.by.email}`);
    publish(c.tenantId, 'order.status',
      { orderId: order.id, orderNumber: order.order_number, status: order.status });
    res.json({ order, totals, approvedBy: auth.by.email });
  } catch (err) { fail(res, err, 'Failed to apply discount'); }
});

// ── X / Z reports ──────────────────────────────────────────────────────
// X = read the figures mid-shift, drawer stays open.
// Z = the same figures at close. Same computation on purpose: a Z derived
// differently from the X staff read an hour earlier is a Z nobody trusts.

posRouter.get('/shifts/:id/report', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid shift id' }); return; }
  const c = ctx(req);
  try {
    const shift = await shiftsRepo.byId(c.tenantId, req.params.id);
    if (!shift) { res.status(404).json({ error: 'Shift not found' }); return; }

    const report = await shiftsRepo.report(c.tenantId, shift);
    await auditPos(c, shift.status === 'open' ? 'pos.report.x' : 'pos.report.z', `shift ${shift.id}`);
    res.json({ report, kind: shift.status === 'open' ? 'X' : 'Z' });
  } catch (err) { fail(res, err, 'Failed to build report'); }
});

// ── Service requests (Call Waiter) ─────────────────────────────────────
// The staff side of the guest app's Call Waiter button. Guests create these
// through /api/guest/service-request; only staff can see or clear them.

posRouter.get('/service-requests', async (req: Request, res: Response) => {
  const c = ctx(req);
  try {
    const requests = await serviceRequestsRepo.open(c.tenantId);

    // Join the table labels in one read rather than per row. The alert has to
    // say "Table 6" to be useful to someone carrying plates, and a busy floor
    // would otherwise issue a query per open request on every poll.
    const tables = await tablesRepo.list(c.tenantId);
    const byId   = new Map(tables.map(t => [t.id, t]));

    res.json(requests.map(r => ({
      id:         r.id,
      tableId:    r.table_id,
      tableLabel: byId.get(r.table_id)?.label ?? '?',
      area:       byId.get(r.table_id)?.area  ?? '',
      type:       r.type,
      note:       r.note,
      status:     r.status,
      createdAt:  r.created_at,
    })));
  } catch (err) { fail(res, err, 'Failed to load service requests'); }
});

posRouter.post('/service-requests/:id/acknowledge', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid request id' }); return; }
  const c = ctx(req);
  try {
    // staffId comes from the PIN-identified operator when the till sends one.
    // It is optional: acknowledging must never be blocked on identifying who
    // did it, because the point is to stop the alert flashing quickly.
    const staffId = typeof (req.body as { staffId?: unknown }).staffId === 'string'
      ? (req.body as { staffId: string }).staffId
      : null;

    const updated = await serviceRequestsRepo.acknowledge(c.tenantId, req.params.id, staffId);
    if (!updated) { res.status(404).json({ error: 'Request not found' }); return; }

    publish(c.tenantId, 'service_request.cleared', { requestId: updated.id, status: 'acknowledged' });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to acknowledge'); }
});

posRouter.post('/service-requests/:id/resolve', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid request id' }); return; }
  const c = ctx(req);
  try {
    const updated = await serviceRequestsRepo.resolve(c.tenantId, req.params.id);
    if (!updated) { res.status(404).json({ error: 'Request not found' }); return; }

    publish(c.tenantId, 'service_request.cleared', { requestId: updated.id, status: 'resolved' });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to resolve'); }
});

// ── Table QR credentials ───────────────────────────────────────────────

posRouter.post('/tables/:id/qr', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid table id' }); return; }
  if (!requireAdmin(req, res)) return;

  const c = ctx(req);
  try {
    const table = await tableQrRepo.byId(c.tenantId, req.params.id);
    if (!table) { res.status(404).json({ error: 'Table not found' }); return; }

    const { qrToken, pin } = await tableQrRepo.issueCredentials(c.tenantId, req.params.id);
    await auditPos(c, 'pos.table.qr_issued', `${table.area}/${table.label}`);

    // Issuing a code and having it actually work must not be two separate
    // steps. Before this, a code could be printed and handed to a diner while
    // channels.qr.enabled was still false — the QR scanned, showed the PIN
    // screen, and then refused every PIN with "Table ordering is not enabled
    // here", which nothing on the admin side explained. The one action a
    // manager takes ("give this table a code") is what turns the channel on.
    if (req.tenantConfig!.channels?.qr?.enabled !== true) {
      await enableQrChannel(c.tenantId, req.tenantConfig!);
    }

    const url   = absoluteGuestUrl(req, qrToken);
    // Rendered here rather than in the browser so the admin bundle does not
    // have to carry a QR library, and so the printed card and the on-screen
    // preview are guaranteed to be the same image.
    const qrSvg = await QRCode.toString(url, {
      type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 260,
    });

    // The clear PIN is returned exactly once, to be printed. It is stored only
    // as a scrypt hash, so it cannot be read back later — losing it means
    // rotating and reprinting that one card.
    res.json({
      qrToken, pin, url, qrSvg,
      table: { id: table.id, label: table.label, area: table.area },
    });
  } catch (err) { fail(res, err, 'Failed to issue QR credentials'); }
});

// Close a table's dine-in session — used when a party leaves so the next group
// scanning the same QR starts a fresh visit rather than joining the last one.
posRouter.post('/tables/:id/close-session', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid table id' }); return; }
  const c = ctx(req);
  try {
    const session = await dineSessionsRepo.openForTable(c.tenantId, req.params.id);
    if (!session) { res.json({ ok: true, closed: false }); return; }

    await dineSessionsRepo.close(c.tenantId, session.id);
    await tablesRepo.update(c.tenantId, req.params.id, { status: 'available' }).catch(() => undefined);
    await auditPos(c, 'pos.table.session_closed', session.id);

    publish(c.tenantId, 'table.status', { tableId: req.params.id, status: 'available' });
    res.json({ ok: true, closed: true });
  } catch (err) { fail(res, err, 'Failed to close the table session'); }
});

// ── Kitchen display ────────────────────────────────────────────────────

posRouter.get('/kds/tickets', async (req: Request, res: Response) => {
  const c = ctx(req);
  try {
    const stationId = typeof req.query.station === 'string' && UUID_RE.test(req.query.station)
      ? req.query.station
      : undefined;
    res.json(await kdsRepo.tickets(c.tenantId, stationId));
  } catch (err) { fail(res, err, 'Failed to load tickets'); }
});

posRouter.get('/kds/stations', async (req: Request, res: Response) => {
  try {
    res.json(await kdsRepo.stations(ctx(req).tenantId));
  } catch (err) { fail(res, err, 'Failed to load stations'); }
});

// Bumping is per LINE, not per order: the drinks are ready long before the
// karahi, and a board that can only bump whole orders forces the kitchen to
// either lie or wait.
posRouter.post('/kds/items/:itemId/bump', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.itemId)) { res.status(400).json({ error: 'Invalid line id' }); return; }
  const c = ctx(req);
  try {
    const staffId = typeof (req.body as { staffId?: unknown }).staffId === 'string'
      ? (req.body as { staffId: string }).staffId : null;

    const line = await kdsRepo.bump(c.tenantId, req.params.itemId, staffId);
    if (!line) { res.status(404).json({ error: 'Line not found' }); return; }

    // When every line on an order is bumped, the ORDER is ready — that is what
    // the front counter and the diner's tracking screen are waiting for.
    const allDone = await kdsRepo.allBumped(line.order_id);
    if (allDone) {
      const updated = await ordersRepo.setStatus(c.tenantId, line.order_id, 'ready');
      if (updated) {
        publish(c.tenantId, 'order.status', {
          orderId: line.order_id, orderNumber: updated.order_number, status: 'ready',
        });
      }
    }

    publish(c.tenantId, 'kds.bumped', { itemId: line.id, orderId: line.order_id, allDone });
    res.json({ ok: true, orderReady: allDone });
  } catch (err) { fail(res, err, 'Failed to bump'); }
});

posRouter.post('/kds/items/:itemId/recall', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.itemId)) { res.status(400).json({ error: 'Invalid line id' }); return; }
  const c = ctx(req);
  try {
    // Recall exists because bumping is one tap and mistakes happen. Without it
    // the only recovery is re-ringing the item, which double-charges.
    const line = await kdsRepo.recall(c.tenantId, req.params.itemId);
    if (!line) { res.status(404).json({ error: 'Line not found' }); return; }

    const order = await ordersRepo.findById(c.tenantId, line.order_id);
    if (order?.status === 'ready') {
      await ordersRepo.setStatus(c.tenantId, line.order_id, 'preparing');
      publish(c.tenantId, 'order.status', {
        orderId: line.order_id, orderNumber: order.order_number, status: 'preparing',
      });
    }

    publish(c.tenantId, 'kds.recalled', { itemId: line.id, orderId: line.order_id });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to recall'); }
});

// ── Printing ───────────────────────────────────────────────────────────
// A failed print NEVER fails the request. The money has already moved, and a
// non-2xx here would invite the till to retry a sale rather than a reprint.

posRouter.post('/orders/:id/print', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid order id' }); return; }
  const parsed = z.object({
    kind:   z.enum(['receipt', 'kitchen']).default('receipt'),
    drawer: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const c   = ctx(req);
  const cfg = req.tenantConfig!;

  try {
    const order = await ordersRepo.findById(c.tenantId, req.params.id);
    if (!order) { res.status(404).json({ error: 'Order not found' }); return; }

    const [items, payments] = await Promise.all([
      ordersRepo.items(order.id),
      paymentsRepo.forOrder(order.id),
    ]);
    const live = items.filter(i => !i.voided_at);

    const printers = parsePrinterConfig(req.adapterCredentials?.printers);
    const target   = parsed.data.kind === 'kitchen' ? printers.kitchen : printers.receipt;

    const table = order.table_id
      ? await tableQrRepo.byId(c.tenantId, order.table_id).catch(() => null)
      : null;

    const data = parsed.data.kind === 'kitchen'
      ? buildKitchenTicket({
          orderNumber: order.order_number,
          orderType:   order.order_type,
          tableLabel:  table?.label ?? null,
          placedAt:    order.created_at,
          // A reprint is always flagged: the cost of a cook missing that is a
          // duplicate dish.
          reprint:     true,
          width:       target?.width,
          lines: live.map(i => ({
            name:      i.dish_name,
            quantity:  i.quantity,
            modifiers: (i.selected_options ?? []).map(o => o.choice_name),
            notes:     i.notes,
            seat:      i.seat_no,
          })),
        })
      : buildReceipt({
          restaurantName: cfg.restaurantName,
          orderNumber:    order.order_number,
          orderType:      order.order_type,
          tableLabel:     table?.label ?? null,
          placedAt:       order.created_at,
          currency:       cfg.businessRules.currencySymbol,
          width:          target?.width,
          lines: live.map(i => ({
            name:      i.dish_name,
            quantity:  i.quantity,
            total:     Number(i.item_total),
            modifiers: (i.selected_options ?? []).map(o => o.choice_name),
            notes:     i.notes,
          })),
          subtotal:      Number(order.subtotal),
          discount:      Number(order.discount),
          serviceCharge: Number(order.service_charge),
          tax:           Number(order.tax_total),
          total:         Number(order.total_amount),
          payments: payments.filter(p => p.status !== 'voided').map(p => ({
            method: p.method,
            amount: Number(p.amount),
            change: Number(p.change_due),
          })),
        });

    await auditPos(c, 'pos.print', `#${order.order_number} ${parsed.data.kind}`);

    if (!target) {
      // No printer configured. Hand the bytes back so the browser can fall
      // back to a print dialog — a till with no network printer is normal in a
      // small restaurant, and refusing outright would leave them no receipt.
      res.json({
        ok: false,
        reason: 'no printer configured',
        payload: data.toString('base64'),
      });
      return;
    }

    const result = await printRaw(target, data);
    if (!result.ok) console.error(`[POS] print failed: ${result.error}`);

    res.json({ ok: result.ok, error: result.error });
  } catch (err) { fail(res, err, 'Failed to print'); }
});

// ── Reporting ──────────────────────────────────────────────────────────
// Aggregation happens in Postgres (pos_report_summary), not here. A month of
// trading is thousands of orders and tens of thousands of lines; pulling that
// over PostgREST to count it in JavaScript would get slower as the tenant
// succeeded, which is the wrong direction for a number to move.

function readRange(req: Request): { from: string; to: string } | null {
  const from = typeof req.query.from === 'string' ? req.query.from : '';
  const to   = typeof req.query.to   === 'string' ? req.query.to   : '';
  if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return null;
  // Guard the range rather than trusting it: a caller asking for the year 1000
  // to 9999 would scan the whole table.
  if (Date.parse(to) - Date.parse(from) > 400 * 86_400_000) return null;
  return { from, to };
}

posRouter.get('/reports/summary', async (req: Request, res: Response) => {
  const range = readRange(req);
  if (!range) {
    res.status(400).json({ error: 'from and to must be ISO-8601 and span at most 400 days' });
    return;
  }
  try {
    res.json(await reportsRepo.summary(ctx(req).tenantId, range.from, range.to));
  } catch (err) { fail(res, err, 'Failed to build the report'); }
});

posRouter.get('/reports/summary.csv', async (req: Request, res: Response) => {
  const range = readRange(req);
  if (!range) { res.status(400).json({ error: 'Invalid range' }); return; }

  try {
    const report = await reportsRepo.summary(ctx(req).tenantId, range.from, range.to);
    const day    = range.from.slice(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sales-${day}.csv"`);
    res.send(toCsv(report));
  } catch (err) { fail(res, err, 'Failed to export'); }
});

/**
 * Turn on QR table ordering, in place, the moment a table's code is issued.
 *
 * Same read-patch-write shape as EnablePosGate/PinGate use over HTTP, done
 * directly here since the route already holds the parsed config. Redis is
 * primary — middleware/tenant.ts reads it first — so it is written before the
 * Postgres mirror; the mirror is best-effort and must never block a QR code
 * a manager is standing there waiting to print.
 */
async function enableQrChannel(tenantId: string, config: TenantConfig): Promise<void> {
  const next = parseTenantConfig({
    ...config,
    channels: {
      ...config.channels,
      qr: {
        enabled:        true,
        requirePin:     config.channels?.qr?.requirePin ?? true,
        orderMode:      config.channels?.qr?.orderMode ?? 'direct',
        waiterCooldown: config.channels?.qr?.waiterCooldown ?? 60,
      },
    },
  });

  await getRedis().set(redisKey.tenantConfig(tenantId), next, { ex: TTL.TENANT_CONFIG });
  void dualWrite('tenant_configs.upsert', tenantConfigsRepo.upsert(tenantId, next));
}

// The guest URL has to be absolute so a printed QR works from a phone on the
// restaurant's wifi, not just from the machine that generated it. Behind a
// proxy, x-forwarded-* is what carries the public scheme and host.
function absoluteGuestUrl(req: Request, qrToken: string): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]
    ?? req.protocol;
  const host  = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]
    ?? req.get('host') ?? 'localhost:3000';
  return `${proto}://${host}/t/${req.tenantConfig!.slug}/${qrToken}`;
}

// Re-render the QR for a table that already has one.
//
// Separate from issuing on purpose: issuing ROTATES the PIN, which invalidates
// every printed card for that table. Viewing the code you already have must
// never do that by accident.
posRouter.get('/tables/:id/qr', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid table id' }); return; }
  const c = ctx(req);
  try {
    const table = await tableQrRepo.byId(c.tenantId, req.params.id);
    if (!table) { res.status(404).json({ error: 'Table not found' }); return; }
    if (!table.qr_token) { res.json({ issued: false }); return; }

    const url   = absoluteGuestUrl(req, table.qr_token);
    const qrSvg = await QRCode.toString(url, {
      type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 260,
    });

    // No PIN. It is stored as a scrypt hash and genuinely cannot be read back —
    // if it has been lost, the answer is to re-issue, not to recover it.
    res.json({
      issued: true, url, qrSvg,
      hasPin: Boolean(table.pin_hash),
      rotatedAt: table.pin_rotated_at,
      table: { id: table.id, label: table.label, area: table.area },
    });
  } catch (err) { fail(res, err, 'Failed to load the QR code'); }
});
