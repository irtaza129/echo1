import jwt from 'jsonwebtoken';

export type UserRole = 'super_admin' | 'tenant_admin' | 'manager' | 'staff' | 'kiosk';

export interface JwtPayload {
  sub: string;       // user UUID
  tenantId: string;  // tenant UUID
  role: UserRole;
  slug: string;      // tenant slug e.g. "savour-foods"
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
