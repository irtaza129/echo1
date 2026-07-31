import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  ordersRepo, paymentsRepo, shiftsRepo, tablesRepo, customersRepo,
  computeTotals, type NewOrderItem,
} from '../src/lib/posRepo.js';
import { auditRepo } from '../src/lib/repo.js';
import { toWireOrder } from '../adapter/PosAdapter.js';

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
