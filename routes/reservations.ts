import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  reservationsRepo, servicePeriodsRepo, blackoutsRepo, waitlistRepo,
  computeAvailability, TableConflictError,
} from '../src/lib/reservationsRepo.js';
import { tablesRepo, ordersRepo } from '../src/lib/posRepo.js';
import { auditRepo } from '../src/lib/repo.js';

// Reservations routes. Mounted in server.ts behind:
//   requireAuth → attachAdapter → requireFeature('reservations')
//
// This module is sold standalone. The only handler that touches the POS is
// POST /:id/seat, and it checks features.pos itself and fails closed — so a
// bookings-only tenant can never reach POS code by any path.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Ctx { tenantId: string; actor: string }

function ctx(req: Request): Ctx {
  return {
    tenantId: req.tenantConfig!.tenantId,
    actor:    req.jwtPayload?.sub ?? 'unknown',
  };
}

async function audit(c: Ctx, action: string, details?: string): Promise<void> {
  try {
    await auditRepo.append({ tenantId: c.tenantId, actor: c.actor, action, details });
  } catch (err) {
    console.error(`[RES] audit write failed — ${action}:`, err);
  }
}

// A TableConflictError is a client error with useful contents: the UI turns the
// returned conflicts into "table 4 is booked 19:00–20:30 — join table 5?".
// Flattening it to a bare 500 would throw that away.
function fail(res: Response, err: unknown, fallback = 'Request failed'): void {
  if (err instanceof TableConflictError) {
    res.status(409).json({
      error:     'One or more of those tables is already booked for that time',
      tableIds:  err.tableIds,
      conflicts: err.conflicts,
    });
    return;
  }
  console.error('[RES]', err instanceof Error ? err.message : String(err));
  res.status(500).json({ error: fallback });
}

export const reservationsRouter = Router();

// ── Reservations ─────────────────────────────────────────────────────────────

reservationsRouter.get('/', async (req: Request, res: Response) => {
  const from = typeof req.query.from === 'string' ? req.query.from : '';
  const to   = typeof req.query.to   === 'string' ? req.query.to   : '';
  if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    res.status(400).json({ error: 'from and to must be ISO-8601 timestamps' });
    return;
  }

  const c = ctx(req);
  try {
    const rows = await reservationsRepo.list(c.tenantId, from, to);
    // Table assignments come back alongside so the timeline can render in one
    // pass rather than issuing a request per booking.
    const withTables = await Promise.all(rows.map(async r => ({
      ...r,
      tableIds: (await reservationsRepo.tablesFor(r.id)).map(t => t.table_id),
    })));
    res.json(withTables);
  } catch (err) { fail(res, err, 'Failed to load reservations'); }
});

const CreateBody = z.object({
  guestName:   z.string().min(1).max(255),
  guestPhone:  z.string().max(32).nullish(),
  guestEmail:  z.string().email().nullish(),
  partySize:   z.number().int().min(1).max(200),
  startsAt:    z.string().refine(s => !Number.isNaN(Date.parse(s)), 'startsAt must be ISO-8601'),
  durationMin: z.number().int().min(15).max(600).optional(),
  tableIds:    z.array(z.string().regex(UUID_RE)).optional(),
  notes:       z.string().max(1000).nullish(),
  source:      z.enum(['staff', 'voice', 'web', 'phone', 'walk_in']).optional(),
});

reservationsRouter.post('/', async (req: Request, res: Response) => {
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const c     = ctx(req);
  const rules = req.tenantConfig!.businessRules.reservations;
  const d     = parsed.data;

  // Booking policy is per-tenant config, enforced server-side: the voice agent
  // and any future public booking page both come through here, and neither can
  // be trusted to have applied the tenant's rules.
  if (d.partySize > rules.maxPartySize) {
    res.status(400).json({ error: `Maximum party size is ${rules.maxPartySize}` });
    return;
  }

  const startMs = Date.parse(d.startsAt);
  const leadMs  = startMs - Date.now();
  if (leadMs < rules.minLeadMinutes * 60_000) {
    res.status(400).json({ error: `Bookings must be at least ${rules.minLeadMinutes} minutes ahead` });
    return;
  }
  if (leadMs > rules.maxAdvanceDays * 86_400_000) {
    res.status(400).json({ error: `Bookings cannot be more than ${rules.maxAdvanceDays} days ahead` });
    return;
  }

  try {
    const reservation = await reservationsRepo.create({
      tenantId:    c.tenantId,
      guestName:   d.guestName,
      guestPhone:  d.guestPhone,
      guestEmail:  d.guestEmail,
      partySize:   d.partySize,
      startsAt:    new Date(startMs).toISOString(),
      durationMin: d.durationMin ?? rules.defaultDuration,
      tableIds:    d.tableIds,
      notes:       d.notes,
      source:      d.source ?? 'staff',
      depositAmount: rules.depositRequired ? rules.depositAmount : 0,
    });

    await audit(c, 'res.create', `${d.guestName} party ${d.partySize} at ${d.startsAt}`);
    res.status(201).json(reservation);
  } catch (err) { fail(res, err, 'Failed to create reservation'); }
});

reservationsRouter.patch('/:id', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid reservation id' }); return; }
  const parsed = z.object({
    guestName:   z.string().min(1).max(255).optional(),
    guestPhone:  z.string().max(32).nullish(),
    partySize:   z.number().int().min(1).max(200).optional(),
    startsAt:    z.string().refine(s => !Number.isNaN(Date.parse(s))).optional(),
    durationMin: z.number().int().min(15).max(600).optional(),
    notes:       z.string().max(1000).nullish(),
    tableIds:    z.array(z.string().regex(UUID_RE)).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const c = ctx(req);
  const { tableIds, ...fields } = parsed.data;

  // snake_case for the DB; only send keys the caller actually supplied so a
  // partial edit cannot blank a column it never mentioned.
  const patch: Record<string, unknown> = {};
  if (fields.guestName   !== undefined) patch.guest_name   = fields.guestName;
  if (fields.guestPhone  !== undefined) patch.guest_phone  = fields.guestPhone;
  if (fields.partySize   !== undefined) patch.party_size   = fields.partySize;
  if (fields.startsAt    !== undefined) patch.starts_at    = new Date(fields.startsAt).toISOString();
  if (fields.durationMin !== undefined) patch.duration_min = fields.durationMin;
  if (fields.notes       !== undefined) patch.notes        = fields.notes;

  try {
    let reservation = Object.keys(patch).length > 0
      ? await reservationsRepo.update(c.tenantId, req.params.id, patch)
      : await reservationsRepo.findById(c.tenantId, req.params.id);

    if (!reservation) { res.status(404).json({ error: 'Reservation not found' }); return; }

    if (tableIds) {
      await reservationsRepo.assignTables(c.tenantId, reservation, tableIds);
      reservation = await reservationsRepo.findById(c.tenantId, req.params.id);
    }

    await audit(c, 'res.update', req.params.id);
    res.json(reservation);
  } catch (err) { fail(res, err, 'Failed to update reservation'); }
});

reservationsRouter.post('/:id/status', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid reservation id' }); return; }
  const parsed = z.object({
    status: z.enum(['booked', 'confirmed', 'seated', 'completed', 'no_show', 'cancelled']),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const c = ctx(req);
  try {
    // Cancelling frees the slot immediately: the trigger in migrations/006
    // flips `blocks` to false, so the exclusion constraint stops holding the
    // table without deleting the booking's history.
    const updated = await reservationsRepo.setStatus(c.tenantId, req.params.id, parsed.data.status);
    if (!updated) { res.status(404).json({ error: 'Reservation not found' }); return; }

    await audit(c, 'res.status', `${req.params.id} → ${parsed.data.status}`);
    res.json(updated);
  } catch (err) { fail(res, err, 'Failed to update status'); }
});

// ── Availability ─────────────────────────────────────────────────────────────

reservationsRouter.get('/availability', async (req: Request, res: Response) => {
  const day       = typeof req.query.date === 'string' ? req.query.date : '';
  const partySize = Number(req.query.partySize ?? 2);
  if (!day || Number.isNaN(Date.parse(day))) {
    res.status(400).json({ error: 'date must be an ISO-8601 date' }); return;
  }
  if (!Number.isFinite(partySize) || partySize < 1) {
    res.status(400).json({ error: 'partySize must be a positive integer' }); return;
  }

  const c     = ctx(req);
  const rules = req.tenantConfig!.businessRules.reservations;
  const dayStart = new Date(day); dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd   = new Date(dayStart.getTime() + 86_400_000);

  try {
    const [tables, periods, blackouts, reservations] = await Promise.all([
      tablesRepo.list(c.tenantId),
      servicePeriodsRepo.list(c.tenantId),
      blackoutsRepo.list(c.tenantId, dayStart.toISOString(), dayEnd.toISOString()),
      reservationsRepo.overlapping(c.tenantId, dayStart.toISOString(), dayEnd.toISOString()),
    ]);

    const withTables = await Promise.all(reservations.map(async r => ({
      starts_at:    r.starts_at,
      duration_min: r.duration_min,
      status:       r.status,
      tableIds:     (await reservationsRepo.tablesFor(r.id)).map(t => t.table_id),
    })));

    res.json(computeAvailability({
      dayIso:       dayStart.toISOString(),
      tables, periods, blackouts,
      reservations: withTables,
      partySize,
      durationMin:  rules.defaultDuration,
      slotMinutes:  rules.slotMinutes,
    }));
  } catch (err) { fail(res, err, 'Failed to compute availability'); }
});

reservationsRouter.get('/tables', async (req: Request, res: Response) => {
  try {
    res.json(await tablesRepo.list(ctx(req).tenantId));
  } catch (err) { fail(res, err, 'Failed to load tables'); }
});

// ── Service periods ──────────────────────────────────────────────────────────

reservationsRouter.get('/service-periods', async (req: Request, res: Response) => {
  try {
    res.json(await servicePeriodsRepo.list(ctx(req).tenantId));
  } catch (err) { fail(res, err, 'Failed to load service periods'); }
});

reservationsRouter.post('/service-periods', async (req: Request, res: Response) => {
  const parsed = z.object({
    name:      z.string().min(1).max(64),
    weekday:   z.number().int().min(0).max(6),
    startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
    endTime:   z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
    maxCovers: z.number().int().min(1).nullish(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  try {
    res.status(201).json(await servicePeriodsRepo.create({
      tenantId: ctx(req).tenantId, ...parsed.data,
    }));
  } catch (err) { fail(res, err, 'Failed to create service period'); }
});

// ── Waitlist ─────────────────────────────────────────────────────────────────

reservationsRouter.get('/waitlist', async (req: Request, res: Response) => {
  try {
    res.json(await waitlistRepo.list(ctx(req).tenantId));
  } catch (err) { fail(res, err, 'Failed to load waitlist'); }
});

reservationsRouter.post('/waitlist', async (req: Request, res: Response) => {
  const parsed = z.object({
    name:          z.string().min(1).max(255),
    phone:         z.string().max(32).nullish(),
    partySize:     z.number().int().min(1).max(200),
    quotedWaitMin: z.number().int().min(0).max(600).nullish(),
    notes:         z.string().max(500).nullish(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  try {
    res.status(201).json(await waitlistRepo.add({ tenantId: ctx(req).tenantId, ...parsed.data }));
  } catch (err) { fail(res, err, 'Failed to add to waitlist'); }
});

reservationsRouter.post('/waitlist/:id/status', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid waitlist id' }); return; }
  const parsed = z.object({
    status: z.enum(['waiting', 'notified', 'seated', 'left', 'cancelled']),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  try {
    await waitlistRepo.setStatus(ctx(req).tenantId, req.params.id, parsed.data.status);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Failed to update waitlist entry'); }
});

// ── Seat a party (the only POS coupling point) ───────────────────────────────
// Opens an empty POS tab on the reservation's table and links the two.
//
// Fails closed: a tenant without the POS module gets 404, not a half-working
// button. That is what keeps Reservations honestly standalone.

reservationsRouter.post('/:id/seat', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Invalid reservation id' }); return; }

  const c = ctx(req);
  if (!req.tenantConfig!.features.pos) {
    res.status(404).json({ error: 'Seating requires the POS module' });
    return;
  }

  try {
    const reservation = await reservationsRepo.findById(c.tenantId, req.params.id);
    if (!reservation) { res.status(404).json({ error: 'Reservation not found' }); return; }
    if (reservation.order_id) {
      res.status(409).json({ error: 'Party is already seated', orderId: reservation.order_id });
      return;
    }

    const assigned = await reservationsRepo.tablesFor(reservation.id);
    const tableId  = assigned[0]?.table_id ?? null;

    // ordersRepo.create refuses an order with no lines — correct for a sale,
    // wrong for opening an empty tab. Seat by marking the booking and the
    // table; the first item rung in creates the order against this table.
    await reservationsRepo.setStatus(c.tenantId, reservation.id, 'seated');
    if (tableId) {
      await tablesRepo.update(c.tenantId, tableId, { status: 'occupied' }).catch(() => undefined);
    }

    // If a tab is already open on that table, hand it back so the POS opens it
    // rather than starting a second one for the same party.
    const openTabs = tableId ? await ordersRepo.openForTable(c.tenantId, tableId) : [];

    await audit(c, 'res.seat', `${reservation.id} → table ${tableId ?? 'none'}`);
    res.json({ reservation: { ...reservation, status: 'seated' }, tableId, openOrder: openTabs[0] ?? null });
  } catch (err) { fail(res, err, 'Failed to seat party'); }
});
