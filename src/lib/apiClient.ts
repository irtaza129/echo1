// Tenant-aware fetch wrapper.
//
// Every call to a tenant-scoped backend route must identify the tenant. We do
// it two ways for defence-in-depth:
//   1. Authorization: Bearer <jwt>   — authoritative when present
//   2. X-Tenant-ID:    <uuid>        — explicit override / used when no JWT
//
// The server middleware (middleware/tenant.ts) cross-checks these and 403s on
// any mismatch, so a stale slug or spoofed header can never make one tenant's
// session read another tenant's data.

const JWT_KEY = 'sf_jwt';

interface JwtClaims { tenantId?: string; slug?: string; role?: string; sub?: string }

function decodeJwt(token: string): JwtClaims | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const pad     = (4 - part.length % 4) % 4;
    const decoded = JSON.parse(atob(part + '='.repeat(pad)));
    return decoded as JwtClaims;
  } catch {
    return null;
  }
}

// Reads the JWT (if any) and the tenant it represents from sessionStorage.
// Exposed so callers can decide whether to skip a request when no tenant is
// known — e.g. the kitchen dashboard shouldn't poll Savour's orders just
// because the caller forgot to log in.
/**
 * The signed-in role, for deciding what to RENDER.
 *
 * Never a permission check: the token is decoded here without verification, so
 * anything that actually grants access must re-derive the role server-side from
 * the verified token. Hiding a button is a courtesy; the server is the control.
 */
export function getCurrentRole(): string | null {
  const jwt = sessionStorage.getItem(JWT_KEY);
  return jwt ? decodeJwt(jwt)?.role ?? null : null;
}

export function getCurrentTenant(): { jwt: string | null; tenantId: string | null } {
  const jwt = sessionStorage.getItem(JWT_KEY);
  if (!jwt) return { jwt: null, tenantId: null };
  const claims = decodeJwt(jwt);
  return { jwt, tenantId: claims?.tenantId ?? null };
}

// Same claim, but from a token the caller already holds rather than from
// sessionStorage — the setup wizard receives its JWT as a prop and must not
// depend on the session having been written yet.
//
// The claim is read for ATTRIBUTION only (Paddle checkout custom_data). It is
// never a permission check: the JWT is unverified here, so anything that grants
// access must re-derive the tenant server-side from the verified token.
export function tenantIdFromToken(token: string): string | null {
  return decodeJwt(token)?.tenantId ?? null;
}

export interface TenantFetchOptions extends RequestInit {
  // Anonymous kiosk pages (customer URLs without a login) won't have a JWT.
  // Pass the tenantId resolved from /api/tenant-config/:slug here so the
  // request still carries X-Tenant-ID.
  tenantIdOverride?: string;
}

export async function tenantFetch(input: string, init: TenantFetchOptions = {}): Promise<Response> {
  const { tenantIdOverride, headers: explicitHeaders, ...rest } = init;
  const { jwt, tenantId: jwtTenantId } = getCurrentTenant();
  const tenantId = tenantIdOverride ?? jwtTenantId ?? null;

  const headers = new Headers(explicitHeaders);
  if (jwt && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${jwt}`);
  if (tenantId && !headers.has('X-Tenant-ID')) headers.set('X-Tenant-ID', tenantId);

  const res = await fetch(input, { ...rest, headers });

  // Server echoes the tenant it actually resolved. If that doesn't match what
  // we expected, surface a console warning — silent cross-tenant responses are
  // exactly the bug class this helper exists to prevent.
  if (tenantId) {
    const resolved = res.headers.get('X-Resolved-Tenant');
    if (resolved && resolved !== tenantId) {
      console.warn(
        `[apiClient] Tenant mismatch on ${input}: expected ${tenantId}, server resolved ${resolved}`,
      );
    }
  }

  return res;
}
