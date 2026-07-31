import axios from 'axios';
import * as db from './supabaseAdmin.js';
import type { VenueTableRow } from './posRepo.js';

// Repository layer for the Reservations module.
//
// This file imports nothing from posRepo except the shared `venue_tables` row
// type. That is deliberate and worth preserving: Reservations is sold on its
// own, so a bookings-only tenant must never end up executing POS code paths.

export interface ReservationRow {
  id:             string;
  tenant_id:      string;
  customer_id:    string | null;
  guest_name:     string;
  guest_phone:    string | null;
  guest_email:    string | null;
  party_size:     number;
  starts_at:      string;
  duration_min:   number;
  status:         string;
  source:         string;
  notes:          string | null;
  deposit_amount: unknown;
  order_id:       string | null;
  created_at:     string;
  updated_at:     string;
}

export interface ReservationTableRow {
  reservation_id: string;
  table_id:       string;
  during:         string;
  blocks:         boolean;
}

export interface ServicePeriodRow {
  id:         string;
  tenant_id:  string;
  name:       string;
  weekday:    number;
  start_time: string;
  end_time:   string;
  max_covers: number | null;
  active:     boolean;
}

export interface BlackoutRow {
  id:        string;
  tenant_id: string;
  starts_at: string;
  ends_at:   string;
  reason:    string | null;
}

// Statuses that still hold a table. Mirrors the `blocks` expression in the
// res_sync_reservation_tables trigger (migrations/006) — if you change one,
// change the other, or availability and the constraint will disagree.
export const BLOCKING_STATUSES = ['booked', 'confirmed', 'seated'] as const;

// Thrown when the DB's exclusion constraint rejects an overlapping booking.
// Carries the conflicting reservations so the UI can offer "join tables" or
// "pick another slot" instead of a bare error.
export class TableConflictError extends Error {
  constructor(public readonly tableIds: string[], public readonly conflicts: ReservationRow[]) {
    super(`Table already booked for that window`);
    this.name = 'TableConflictError';
  }
}

// Postgres raises 23P01 (exclusion_violation) when res_no_double_booking fires;
// PostgREST surfaces it as HTTP 409. Detect both — the numeric code is the
// reliable one, the status is the fallback.
function isExclusionViolation(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const data = err.response?.data as { code?: string } | undefined;
  return data?.code === '23P01' || err.response?.status === 409;
}

function windowEnd(startsAt: string, durationMin: number): string {
  return new Date(new Date(startsAt).getTime() + durationMin * 60_000).toISOString();
}

export const reservationsRepo = {
  list(tenantId: string, fromIso: string, toIso: string): Promise<ReservationRow[]> {
    return db.selectMany<ReservationRow>('res_reservations', {
      tenant_id: `eq.${tenantId}`,
      starts_at: `gte.${fromIso}`,
      and:       `(starts_at.lte.${toIso})`,
      order:     'starts_at.asc',
    });
  },

  findById(tenantId: string, id: string): Promise<ReservationRow | null> {
    return db.selectOne<ReservationRow>('res_reservations', {
      id: `eq.${id}`, tenant_id: `eq.${tenantId}`,
    });
  },

  tablesFor(reservationId: string): Promise<ReservationTableRow[]> {
    return db.selectMany<ReservationTableRow>('res_reservation_tables', {
      reservation_id: `eq.${reservationId}`,
    });
  },

  // Reservations overlapping [from, to) that still hold a table.
  async overlapping(tenantId: string, fromIso: string, toIso: string): Promise<ReservationRow[]> {
    const rows = await db.selectMany<ReservationRow>('res_reservations', {
      tenant_id: `eq.${tenantId}`,
      status:    `in.(${BLOCKING_STATUSES.join(',')})`,
      // Cheap pre-filter in SQL; exact overlap is decided below, where the
      // per-row duration is known. A reservation cannot start more than a day
      // before the window and still overlap it under any sane turn time.
      starts_at: `gte.${new Date(new Date(fromIso).getTime() - 86_400_000).toISOString()}`,
      and:       `(starts_at.lt.${toIso})`,
      order:     'starts_at.asc',
    });

    const from = new Date(fromIso).getTime();
    const to   = new Date(toIso).getTime();
    return rows.filter(r => {
      const s = new Date(r.starts_at).getTime();
      return s < to && s + r.duration_min * 60_000 > from;
    });
  },

  // Creates the booking and claims its tables. The DB's exclusion constraint is
  // what actually prevents a double booking — two staff hitting "book" on the
  // last table at the same instant both pass any application-level check, and
  // only a constraint can make one of them lose.
  //
  // If claiming the tables fails, the parent reservation is removed so a
  // half-created booking never lingers.
  async create(r: {
    tenantId: string; guestName: string; guestPhone?: string | null; guestEmail?: string | null;
    partySize: number; startsAt: string; durationMin: number;
    tableIds?: string[]; notes?: string | null; source?: string;
    customerId?: string | null; depositAmount?: number; status?: string;
  }): Promise<ReservationRow> {
    const reservation = await db.insertReturning<ReservationRow>('res_reservations', {
      tenant_id:      r.tenantId,
      customer_id:    r.customerId ?? null,
      guest_name:     r.guestName,
      guest_phone:    r.guestPhone ?? null,
      guest_email:    r.guestEmail ?? null,
      party_size:     r.partySize,
      starts_at:      r.startsAt,
      duration_min:   r.durationMin,
      status:         r.status ?? 'booked',
      source:         r.source ?? 'staff',
      notes:          r.notes ?? null,
      deposit_amount: r.depositAmount ?? 0,
    });

    const tableIds = r.tableIds ?? [];
    if (tableIds.length === 0) return reservation;

    const during = `[${r.startsAt},${windowEnd(r.startsAt, r.durationMin)})`;
    try {
      await db.insertMany('res_reservation_tables', tableIds.map(tid => ({
        reservation_id: reservation.id,
        table_id:       tid,
        during,
        blocks:         true,
      })));
    } catch (err) {
      await db.remove('res_reservations', { id: `eq.${reservation.id}` }).catch(() => undefined);
      if (isExclusionViolation(err)) {
        const conflicts = await reservationsRepo.overlapping(
          r.tenantId, r.startsAt, windowEnd(r.startsAt, r.durationMin),
        );
        throw new TableConflictError(tableIds, conflicts);
      }
      throw err;
    }

    return reservation;
  },

  // Rescheduling only touches the parent: the trigger in migrations/006
  // rewrites each child row's `during`, and the exclusion constraint re-checks
  // the new window automatically.
  async update(tenantId: string, id: string, patch: Record<string, unknown>): Promise<ReservationRow | null> {
    try {
      const rows = await db.updateReturning<ReservationRow>('res_reservations', {
        id: `eq.${id}`, tenant_id: `eq.${tenantId}`,
      }, patch);
      return rows[0] ?? null;
    } catch (err) {
      if (isExclusionViolation(err)) throw new TableConflictError([], []);
      throw err;
    }
  },

  setStatus(tenantId: string, id: string, status: string): Promise<ReservationRow | null> {
    return reservationsRepo.update(tenantId, id, { status });
  },

  async assignTables(tenantId: string, reservation: ReservationRow, tableIds: string[]): Promise<void> {
    await db.remove('res_reservation_tables', { reservation_id: `eq.${reservation.id}` });
    if (tableIds.length === 0) return;

    const during = `[${reservation.starts_at},${windowEnd(reservation.starts_at, reservation.duration_min)})`;
    try {
      await db.insertMany('res_reservation_tables', tableIds.map(tid => ({
        reservation_id: reservation.id,
        table_id:       tid,
        during,
        blocks:         !['cancelled', 'no_show', 'completed'].includes(reservation.status),
      })));
    } catch (err) {
      if (isExclusionViolation(err)) {
        const conflicts = await reservationsRepo.overlapping(
          tenantId, reservation.starts_at,
          windowEnd(reservation.starts_at, reservation.duration_min),
        );
        throw new TableConflictError(tableIds, conflicts);
      }
      throw err;
    }
  },

  // Links a booking to the POS order opened when the party sat down. Called
  // only from the feature-gated /seat route; the column is nullable so a
  // reservations-only tenant never populates it.
  async linkOrder(tenantId: string, id: string, orderId: string): Promise<void> {
    await db.update('res_reservations', { id: `eq.${id}`, tenant_id: `eq.${tenantId}` }, {
      order_id: orderId, status: 'seated',
    });
  },
};

// ── Availability ─────────────────────────────────────────────────────────────

export const servicePeriodsRepo = {
  list(tenantId: string): Promise<ServicePeriodRow[]> {
    return db.selectMany<ServicePeriodRow>('res_service_periods', {
      tenant_id: `eq.${tenantId}`, active: 'eq.true', order: 'weekday.asc,start_time.asc',
    });
  },

  create(p: {
    tenantId: string; name: string; weekday: number;
    startTime: string; endTime: string; maxCovers?: number | null;
  }): Promise<ServicePeriodRow> {
    return db.insertReturning<ServicePeriodRow>('res_service_periods', {
      tenant_id:  p.tenantId,
      name:       p.name,
      weekday:    p.weekday,
      start_time: p.startTime,
      end_time:   p.endTime,
      max_covers: p.maxCovers ?? null,
    });
  },
};

export const blackoutsRepo = {
  list(tenantId: string, fromIso: string, toIso: string): Promise<BlackoutRow[]> {
    return db.selectMany<BlackoutRow>('res_blackouts', {
      tenant_id: `eq.${tenantId}`,
      ends_at:   `gte.${fromIso}`,
      and:       `(starts_at.lte.${toIso})`,
      order:     'starts_at.asc',
    });
  },
};

export interface AvailableSlot {
  startsAt:  string;
  tableIds:  string[];
  seatsFree: number;
}

// Which tables can seat `partySize` at each candidate start time in a day.
//
// Deliberately a pure function over data the caller already fetched: it does no
// I/O, so the route can cache the inputs and the whole thing stays testable
// without a database.
export function computeAvailability(args: {
  dayIso:       string;
  tables:       VenueTableRow[];
  reservations: { starts_at: string; duration_min: number; status: string; tableIds: string[] }[];
  periods:      ServicePeriodRow[];
  blackouts:    BlackoutRow[];
  partySize:    number;
  durationMin:  number;
  slotMinutes:  number;
}): AvailableSlot[] {
  const day     = new Date(args.dayIso);
  const weekday = day.getUTCDay();
  const periods = args.periods.filter(p => p.weekday === weekday);
  if (periods.length === 0) return [];

  // Only tables that can physically seat the party. Joining tables for large
  // parties is a staff decision, not something to guess at here.
  const usable = args.tables.filter(t => t.status !== 'disabled' && t.seats >= args.partySize);
  if (usable.length === 0) return [];

  const busy = args.reservations.filter(r => BLOCKING_STATUSES.includes(r.status as typeof BLOCKING_STATUSES[number]));
  const slots: AvailableSlot[] = [];

  for (const period of periods) {
    const [sh, sm] = period.start_time.split(':').map(Number);
    const [eh, em] = period.end_time.split(':').map(Number);
    const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());

    const open  = dayStart + (sh * 60 + sm) * 60_000;
    const close = dayStart + (eh * 60 + em) * 60_000;

    // A booking must finish before service ends, so the last usable start is
    // `close - duration`, not `close`.
    for (let t = open; t + args.durationMin * 60_000 <= close; t += args.slotMinutes * 60_000) {
      const slotStart = t;
      const slotEnd   = t + args.durationMin * 60_000;

      const blacked = args.blackouts.some(b =>
        new Date(b.starts_at).getTime() < slotEnd && new Date(b.ends_at).getTime() > slotStart);
      if (blacked) continue;

      const taken = new Set<string>();
      for (const r of busy) {
        const rs = new Date(r.starts_at).getTime();
        const re = rs + r.duration_min * 60_000;
        if (rs < slotEnd && re > slotStart) r.tableIds.forEach(id => taken.add(id));
      }

      const free = usable.filter(tb => !taken.has(tb.id));
      if (free.length === 0) continue;

      slots.push({
        startsAt:  new Date(slotStart).toISOString(),
        tableIds:  free.map(f => f.id),
        seatsFree: free.reduce((s, f) => s + f.seats, 0),
      });
    }
  }

  return slots;
}

// ── Waitlist ─────────────────────────────────────────────────────────────────

export interface WaitlistRow {
  id:              string;
  tenant_id:       string;
  name:            string;
  phone:           string | null;
  party_size:      number;
  quoted_wait_min: number | null;
  status:          string;
  notes:           string | null;
  created_at:      string;
}

export const waitlistRepo = {
  list(tenantId: string): Promise<WaitlistRow[]> {
    return db.selectMany<WaitlistRow>('res_waitlist', {
      tenant_id: `eq.${tenantId}`,
      status:    'in.(waiting,notified)',
      order:     'created_at.asc',
    });
  },

  add(w: {
    tenantId: string; name: string; phone?: string | null;
    partySize: number; quotedWaitMin?: number | null; notes?: string | null;
  }): Promise<WaitlistRow> {
    return db.insertReturning<WaitlistRow>('res_waitlist', {
      tenant_id:       w.tenantId,
      name:            w.name,
      phone:           w.phone ?? null,
      party_size:      w.partySize,
      quoted_wait_min: w.quotedWaitMin ?? null,
      notes:           w.notes ?? null,
    });
  },

  async setStatus(tenantId: string, id: string, status: string): Promise<void> {
    await db.update('res_waitlist', { id: `eq.${id}`, tenant_id: `eq.${tenantId}` }, { status });
  },
};
