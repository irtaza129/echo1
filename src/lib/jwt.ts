import jwt from 'jsonwebtoken';

// 'guest' is a DINER at a table, not a member of staff. It is in this union
// only so a single verify path can decode both kinds of token; every staff
// route must reject it explicitly. See requireAuth in server.ts and
// requireGuest in middleware/guest.ts — the two are mirror images on purpose.
export type UserRole = 'super_admin' | 'tenant_admin' | 'manager' | 'staff' | 'kiosk' | 'guest';

export interface JwtPayload {
  sub: string;       // user UUID
  tenantId: string;  // tenant UUID
  role: UserRole;
  slug: string;      // tenant slug e.g. "savour-foods"
  // Present ONLY on guest tokens. A staff token that somehow carried these
  // would still be rejected by requireGuest, which checks the role.
  tableId?:       string;
  dineSessionId?: string;
}

// A diner's session lasts a meal, not a working day. Three hours covers a long
// dinner; anything longer is a token left alive on a phone that walked out.
const GUEST_TTL_SECONDS = 3 * 60 * 60;

export interface GuestClaims {
  tenantId:      string;
  slug:          string;
  tableId:       string;
  dineSessionId: string;
}

export function issueGuestJwt(c: GuestClaims): string {
  return jwt.sign({
    sub:  `guest:${c.dineSessionId}`,
    role: 'guest' as const,
    tenantId: c.tenantId,
    slug:     c.slug,
    tableId:  c.tableId,
    dineSessionId: c.dineSessionId,
  }, getSecret(), { expiresIn: GUEST_TTL_SECONDS, algorithm: 'HS256' });
}

const TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12 h

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('[JWT] JWT_SECRET is not set');
  return secret;
}

export function issueJwt(payload: JwtPayload): string {
  return jwt.sign(payload, getSecret(), {
    expiresIn: TOKEN_TTL_SECONDS,
    algorithm: 'HS256',
  });
}

export function verifyJwt(token: string): JwtPayload {
  const decoded = jwt.verify(token, getSecret(), { algorithms: ['HS256'] });
  return decoded as JwtPayload;
}

// Extracts and verifies JWT from "Authorization: Bearer <token>" header.
// Returns null if missing or invalid — callers decide how to respond.
export function extractJwt(authHeader: string | undefined): JwtPayload | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    return verifyJwt(authHeader.slice(7));
  } catch {
    return null;
  }
}
