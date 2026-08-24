import crypto from 'crypto';
import * as db from './supabaseAdmin.js';
import { hashPin, verifyPin } from './pin.js';

// Dine-in QR sessions and table service requests.
//
// The QR token and the printed PIN are a deliberate pair:
//   • the token identifies the table and lives in the QR
//   • the PIN proves the person is actually sitting at it, and is printed beside
//     the QR, never encoded in it
//
// So a QR photographed from outside is inert, and a leaked PIN is rotated from
// the admin panel without reprinting a single card.

export interface VenueTableRow {
  id:             string;
  tenant_id:      string;
  area:           string;
  label:          string;
  seats:          number;
  status:         string;
  qr_token:       string | null;
  pin_hash:       string | null;
  pin_rotated_at: string | null;
}

export interface DineSessionRow {
  id:         string;
  tenant_id:  string;
  table_id:   string;
  opened_at:  string;
  closed_at:  string | null;
  guest_name: string | null;
  status:     string;
}

export interface ServiceRequestRow {
  id:              string;
  tenant_id:       string;
  table_id:        string;
  dine_session_id: string | null;
  type:            string;
  note:            string | null;
  status:          string;
  created_at:      string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_at:     string | null;
}

// 22 chars of base64url from 16 random bytes. Long enough that guessing is
// hopeless, short enough to stay a dense QR that scans from a phone held at a
// normal distance over a table.
export function generateQrToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

// A table PIN is 4 digits because a diner types it once on their own phone and
// a longer one gets ignored or written on the table. Generated rather than
// chosen: a human picking table PINs makes them all 1111.
export function generateTablePin(): string {
  // Rejection-sample so every value is equally likely — `% 10000` would bias
  // the low end. Then avoid the handful of PINs that read as "not set".
  for (;;) {
    const n = crypto.randomBytes(2).readUInt16BE(0);
    if (n >= 60000) continue;                 // 60000 = 6 * 10000, the clean cut
    const pin = String(n % 10000).padStart(4, '0');
    if (!/^(\d)\1{3}$/.test(pin) && pin !== '1234') return pin;
  }
}

export const tableQrRepo = {
  /**
   * Resolve a QR token to its table.
   *
   * The tenant is NOT taken from the URL slug — it is read from the table row
   * the token belongs to. A token is globally unique, so trusting it is safe;
   * trusting the slug beside it in the URL would let someone point a real token
   * at a different restaurant.
   */
  byToken(qrToken: string): Promise<VenueTableRow | null> {
    return db.selectOne<VenueTableRow>('venue_tables', { qr_token: `eq.${qrToken}` });
  },

  byId(tenantId: string, tableId: string): Promise<VenueTableRow | null> {
    return db.selectOne<VenueTableRow>('venue_tables', {
      id: `eq.${tableId}`, tenant_id: `eq.${tenantId}`,
    });
  },

  /** Mint a fresh token and PIN. Returns the PIN in clear ONCE, to be printed. */
  async issueCredentials(tenantId: string, tableId: string): Promise<{ qrToken: string; pin: string }> {
    const qrToken = generateQrToken();
    const pin     = generateTablePin();

    await db.update('venue_tables', { id: `eq.${tableId}`, tenant_id: `eq.${tenantId}` }, {
      qr_token:       qrToken,
      pin_hash:       await hashPin(pin),
      pin_rotated_at: new Date().toISOString(),
    });

    // The clear PIN is never stored and never returned again. Losing it means
    // rotating, which is a two-second operation and a reprint of one card.
    return { qrToken, pin };
  },

  async checkPin(table: VenueTableRow, pin: string): Promise<boolean> {
    if (!table.pin_hash) return false;
    return verifyPin(pin, table.pin_hash);
  },
};

export const dineSessionsRepo = {
  openForTable(tenantId: string, tableId: string): Promise<DineSessionRow | null> {
    return db.selectOne<DineSessionRow>('dine_sessions', {
      tenant_id: `eq.${tenantId}`, table_id: `eq.${tableId}`, status: 'eq.open',
    });
  },

  byId(tenantId: string, id: string): Promise<DineSessionRow | null> {
    return db.selectOne<DineSessionRow>('dine_sessions', {
      id: `eq.${id}`, tenant_id: `eq.${tenantId}`,
    });
  },

  /**
   * Join the table's open session, or start one.
   *
   * Four people at one table scanning the same QR must land in the SAME session
   * — that is how a group builds one shared cart and gets one bill. Starting a
   * session per device is the design that produces four separate tabs for one
   * table and no way to tell which is the real one.
   *
   * A unique partial index enforces one open session per table, so if two
   * phones scan simultaneously the loser's insert fails and it re-reads the
   * winner's session rather than creating a second.
   */
  async joinOrStart(tenantId: string, tableId: string): Promise<DineSessionRow> {
    const existing = await this.openForTable(tenantId, tableId);
    if (existing) return existing;

    try {
      return await db.insertReturning<DineSessionRow>('dine_sessions', {
        tenant_id: tenantId, table_id: tableId, status: 'open',
      });
    } catch (err) {
      const raced = await this.openForTable(tenantId, tableId);
      if (raced) return raced;
      throw err;
    }
  },

  async close(tenantId: string, id: string): Promise<void> {
    await db.update('dine_sessions', { id: `eq.${id}`, tenant_id: `eq.${tenantId}` }, {
      status: 'closed', closed_at: new Date().toISOString(),
    });
  },

  async setGuestName(tenantId: string, id: string, name: string): Promise<void> {
    await db.update('dine_sessions', { id: `eq.${id}`, tenant_id: `eq.${tenantId}` }, {
      guest_name: name,
    });
  },
};

export const serviceRequestsRepo = {
  /** Open requests for the whole floor, oldest first — the cashier's alert list. */
  open(tenantId: string): Promise<ServiceRequestRow[]> {
    return db.selectMany<ServiceRequestRow>('service_requests', {
      tenant_id: `eq.${tenantId}`,
      status:    'neq.resolved',
      order:     'created_at.asc',
    });
  },

  /** How recently this table asked — used to enforce the per-table cooldown. */
  latestForTable(tenantId: string, tableId: string): Promise<ServiceRequestRow | null> {
    return db.selectOne<ServiceRequestRow>('service_requests', {
      tenant_id: `eq.${tenantId}`, table_id: `eq.${tableId}`, order: 'created_at.desc',
    });
  },

  create(r: {
    tenantId: string; tableId: string; dineSessionId?: string | null;
    type: string; note?: string | null;
  }): Promise<ServiceRequestRow> {
    return db.insertReturning<ServiceRequestRow>('service_requests', {
      tenant_id:       r.tenantId,
      table_id:        r.tableId,
      dine_session_id: r.dineSessionId ?? null,
      type:            r.type,
      note:            r.note ?? null,
      status:          'open',
    });
  },

  async acknowledge(tenantId: string, id: string, byStaffId: string | null): Promise<ServiceRequestRow | null> {
    const rows = await db.updateReturning<ServiceRequestRow>('service_requests', {
      id: `eq.${id}`, tenant_id: `eq.${tenantId}`,
    }, {
      status: 'acknowledged', acknowledged_by: byStaffId, acknowledged_at: new Date().toISOString(),
    });
    return rows[0] ?? null;
  },

  async resolve(tenantId: string, id: string): Promise<ServiceRequestRow | null> {
    // Resolved rows are kept, never deleted: how long a table waited is a real
    // service metric and it only exists if the row survives.
    const rows = await db.updateReturning<ServiceRequestRow>('service_requests', {
      id: `eq.${id}`, tenant_id: `eq.${tenantId}`,
    }, {
      status: 'resolved', resolved_at: new Date().toISOString(),
    });
    return rows[0] ?? null;
  },
};
