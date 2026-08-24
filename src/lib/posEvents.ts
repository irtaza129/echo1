import { EventEmitter } from 'events';

// In-process event bus for the POS, fanned out to browsers over SSE.
//
// Why not Redis pub/sub
// ---------------------
// Upstash is reached over REST, and the REST client cannot SUBSCRIBE — there is
// no long-lived connection to carry a subscription. So the fan-out is in-process.
//
// That is honest for how this deploys today (one Render instance), and it fails
// in a specific, bounded way if that ever changes: a terminal connected to
// instance A would not see an event published on instance B. The mitigation is
// already designed for — every POS screen also reconciles against Postgres on a
// slow interval, so a missed event costs latency, never correctness. When a
// second instance is actually needed, replace `bus` with a Redis/Postgres
// LISTEN-NOTIFY transport and nothing above this file changes.

export type PosEventType =
  | 'order.created'
  | 'order.status'
  | 'order.paid'
  | 'order.voided'
  | 'order.transferred'
  | 'table.status'
  | 'service_request.created'
  | 'service_request.cleared'
  | 'shift.opened'
  | 'shift.closed'
  // Kitchen display. Separate from order.status because a bump changes ONE
  // line, and only the last one changes the order.
  | 'kds.bumped'
  | 'kds.recalled';

export interface PosEvent {
  /** Monotonic per tenant. Drives Last-Event-ID replay after a reconnect. */
  id:   number;
  type: PosEventType;
  at:   string;
  data: Record<string, unknown>;
}

// How many events to keep per tenant for replay. A terminal that drops off for
// a few seconds needs a handful; one that drops off for an hour is better off
// refetching than replaying, and gets told to (see `replaySince`).
const RING_SIZE = 200;

// Sweep tenants with no listeners whose traffic has gone quiet, so a long-lived
// process does not accumulate a buffer per tenant that ever connected.
const IDLE_MS       = 30 * 60 * 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;

interface TenantChannel {
  seq:    number;
  ring:   PosEvent[];
  lastAt: number;
}

const bus      = new EventEmitter();
// Each SSE connection adds a listener; a busy restaurant can legitimately have
// a dozen terminals on one tenant. The default cap of 10 would print a spurious
// leak warning, so raise it rather than let it cry wolf.
bus.setMaxListeners(0);

const channels = new Map<string, TenantChannel>();

function channel(tenantId: string): TenantChannel {
  let c = channels.get(tenantId);
  if (!c) {
    c = { seq: 0, ring: [], lastAt: Date.now() };
    channels.set(tenantId, c);
  }
  return c;
}

/**
 * Publish an event to every terminal watching this tenant.
 *
 * Never throws and never returns a promise: callers are route handlers that
 * have already committed a sale, and a notification failure must not turn a
 * successful payment into a 500.
 */
export function publish(
  tenantId: string,
  type: PosEventType,
  data: Record<string, unknown> = {},
): void {
  try {
    const c = channel(tenantId);
    const event: PosEvent = {
      id:   ++c.seq,
      type,
      at:   new Date().toISOString(),
      data,
    };

    c.ring.push(event);
    if (c.ring.length > RING_SIZE) c.ring.splice(0, c.ring.length - RING_SIZE);
    c.lastAt = Date.now();

    bus.emit(tenantId, event);
  } catch (err) {
    console.error('[POS-EVENTS] publish failed:', err);
  }
}

/**
 * Returns an unsubscribe function. Always call it on connection close.
 *
 * Each subscriber is wrapped so a throw is contained to that one connection.
 * EventEmitter.emit() calls listeners synchronously and lets an exception
 * propagate, which would abandon every listener registered after the failing
 * one — a single wedged terminal would silently starve the rest of the floor of
 * events. Containment has to happen per listener, not around the emit.
 */
export function subscribe(tenantId: string, onEvent: (e: PosEvent) => void): () => void {
  const guarded = (e: PosEvent) => {
    try {
      onEvent(e);
    } catch (err) {
      console.error(`[POS-EVENTS] subscriber for tenant ${tenantId} threw:`, err);
    }
  };

  bus.on(tenantId, guarded);
  return () => { bus.off(tenantId, guarded); };
}

export interface ReplayResult {
  events: PosEvent[];
  /**
   * True when the client's Last-Event-ID is older than anything still buffered,
   * so the gap cannot be filled. The client must refetch its state rather than
   * assume it is up to date — silently sending a partial replay is how a
   * terminal ends up permanently missing an order.
   */
  gap: boolean;
}

export function replaySince(tenantId: string, lastEventId: number | null): ReplayResult {
  const c = channels.get(tenantId);
  if (!c || c.ring.length === 0) return { events: [], gap: false };
  if (lastEventId === null)      return { events: [], gap: false };

  // Already current, or ahead of us (server restarted and seq reset) — treat
  // "ahead" as a gap, because our ids no longer mean what the client thinks.
  if (lastEventId >= c.seq) {
    return { events: [], gap: lastEventId > c.seq };
  }

  const oldest = c.ring[0].id;
  if (lastEventId < oldest - 1) {
    return { events: [], gap: true };
  }

  return { events: c.ring.filter(e => e.id > lastEventId), gap: false };
}

/** Live connection count for a tenant — used by the status endpoint and tests. */
export function listenerCount(tenantId: string): number {
  return bus.listenerCount(tenantId);
}

const sweep = setInterval(() => {
  const cutoff = Date.now() - IDLE_MS;
  for (const [tenantId, c] of channels) {
    if (bus.listenerCount(tenantId) === 0 && c.lastAt < cutoff) {
      channels.delete(tenantId);
    }
  }
}, SWEEP_EVERY_MS);

// Do not hold the process open for a housekeeping timer.
sweep.unref?.();
