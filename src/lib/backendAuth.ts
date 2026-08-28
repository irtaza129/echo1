import jwt from 'jsonwebtoken';

// ─────────────────────────────────────────────────────────────────────────────
// Outbound credentials for the menu/voice-agent service (the FastAPI upstream).
//
// That service gates its menu, agent and admin routes behind AUTH_ENFORCED. It
// cannot be turned on until this app sends a token, because until now every
// call carried only `X-Tenant-ID` — a header, asserted by the caller, proving
// nothing. Anyone who knew a tenant's UUID could read its menu or overwrite it
// through POST /admin/menu.
//
// A SEPARATE SECRET FROM src/lib/jwt.ts, DELIBERATELY. That one signs staff
// logins and guest tokens for this platform. Sharing it would mean anyone with
// access to the upstream's environment — a deployment dashboard, a CI log, a
// committed .env, which is exactly how that project's anon key became public —
// could mint a super_admin till token or a guest token for any tenant. Two
// secrets, two blast radii, independently rotatable.
//
// THE TOKEN IS LONG-LIVED AND STATIC. The upstream validates `exp` only when
// present, so omitting it lets one token per (tenant, role) be minted once and
// reused. That is the operational simplicity of a shared static secret with a
// real signature behind it — which matters, because the upstream rejects a bare
// secret string: it calls jwt.decode() and requires a well-formed JWS.
//
// ROLLOUT. With BACKEND_JWT_SECRET unset this returns nothing and every call
// goes out exactly as before. Setting it is what turns tokens on, and it must
// happen on BOTH sides before either flips anything: the upstream never
// downgrades a present-but-invalid token to the header, so a mismatched secret
// breaks every call immediately, AUTH_ENFORCED or not.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The upstream's role vocabulary. Deliberately its own type rather than
 * src/lib/jwt.ts's UserRole: they overlap today but they are two services'
 * independent vocabularies, and coupling them means a role added here silently
 * becomes a claim there.
 */
export type BackendRole = 'super_admin' | 'tenant_admin' | 'manager' | 'staff' | 'kiosk';

// One token per (tenant, role). Nothing expires, so nothing needs evicting;
// the map is bounded by tenant count.
const tokens = new Map<string, string>();

let warned = false;

/**
 * A bearer token for one tenant, or null when no secret is configured.
 *
 * Null is the pre-rollout state and is not an error — callers omit the header
 * and the upstream falls back to `X-Tenant-ID`, which is what happens today.
 */
export function backendToken(tenantId: string, role: BackendRole): string | null {
  const secret = process.env.BACKEND_JWT_SECRET;
  if (!secret) {
    if (!warned) {
      warned = true;
      console.warn('[BACKEND-AUTH] BACKEND_JWT_SECRET not set — upstream calls are unauthenticated');
    }
    return null;
  }

  const key = `${tenantId}:${role}`;
  const hit = tokens.get(key);
  if (hit) return hit;

  // camelCase tenantId, not tenant_id: the upstream reads that exact claim name
  // and 401s on its absence. No exp — see the header.
  const token = jwt.sign({ tenantId, role }, secret, { algorithm: 'HS256' });
  tokens.set(key, token);
  return token;
}

/**
 * Headers for an outbound call: the tenant header, plus Authorization once a
 * secret is configured.
 *
 * X-Tenant-ID stays. The upstream accepts both and 403s if they disagree, so
 * keeping it means the migration is additive — and it is what the upstream logs
 * on to tell which callers have not moved to tokens yet.
 */
export function backendHeaders(tenantId: string, role: BackendRole): Record<string, string> {
  const headers: Record<string, string> = { 'X-Tenant-ID': tenantId };
  const token = backendToken(tenantId, role);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
