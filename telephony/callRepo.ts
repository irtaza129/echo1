import * as db from '../src/lib/supabaseAdmin.js';

// Call records (migration 014).
//
// Every write here is best-effort at the call site: losing a call record is a
// reporting loss, but failing a call because the reporting table was slow is a
// customer who cannot order. CallSession catches around each of these.

export type CallOutcome =
  | 'in_progress' | 'ordered' | 'enquiry' | 'abandoned' | 'transferred' | 'failed';

export interface CallRow {
  id:          string;
  tenant_id:   string;
  from_number: string | null;
  to_did:      string | null;
  started_at:  string;
  answered_at: string | null;
  ended_at:    string | null;
  duration_s:  number | null;
  outcome:     string;
  order_id:    string | null;
}

/** Last four digits only. A full number in a log line is a number in a log aggregator. */
export function maskNumber(n: string | null | undefined): string {
  if (!n) return 'unknown';
  return n.length <= 4 ? '****' : `****${n.slice(-4)}`;
}

export const callsRepo = {
  async start(c: {
    tenantId: string;
    fromNumber: string | null;
    toDid: string | null;
    channelRef: string | null;
  }): Promise<string> {
    const row = await db.insertReturning<CallRow>('pos_calls', {
      tenant_id:   c.tenantId,
      direction:   'inbound',
      from_number: c.fromNumber,
      to_did:      c.toDid,
      channel_ref: c.channelRef,
      outcome:     'in_progress',
    });
    return row.id;
  },

  async markAnswered(id: string | null): Promise<void> {
    if (!id) return;
    await db.update('pos_calls', { id: `eq.${id}` }, { answered_at: new Date().toISOString() });
  },

  async finish(id: string | null, r: {
    outcome: CallOutcome;
    orderId: string | null;
    transcript: unknown[];
    error?: string | null;
  }): Promise<void> {
    if (!id) return;

    const existing = await db.selectOne<CallRow>('pos_calls', { id: `eq.${id}` });
    const endedAt  = new Date();

    // Duration measured from the ROW, not from a timer held in memory: a
    // process restart mid-call would otherwise write a nonsense figure.
    const duration = existing
      ? Math.max(0, Math.round((endedAt.getTime() - new Date(existing.started_at).getTime()) / 1000))
      : null;

    await db.update('pos_calls', { id: `eq.${id}` }, {
      ended_at:   endedAt.toISOString(),
      duration_s: duration,
      outcome:    r.outcome,
      order_id:   r.orderId,
      transcript: r.transcript,
      error:      r.error ?? null,
    });
  },

  recent(tenantId: string, limit = 50): Promise<CallRow[]> {
    return db.selectMany<CallRow>('pos_calls', {
      tenant_id: `eq.${tenantId}`, order: 'started_at.desc', limit: String(limit),
    });
  },
};
