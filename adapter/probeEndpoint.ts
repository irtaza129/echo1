import axios from 'axios';
import type { DiscoveredField, HttpMethod, ProbeResult } from '../src/lib/posPresets.js';

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint discovery — figures out what a third-party POS endpoint actually
// requires, so the onboarding UI can pop the right input fields instead of
// making the onboarder guess.
//
// Two strategies, in order of reliability:
//   1. OpenAPI/Swagger import — if the API publishes a spec at a well-known URL,
//      parse the exact required params / filters for the endpoint.
//   2. Live probe — send a minimal request and read the response: 401/403 ⇒
//      auth needed; 400/422 with a structured error body ⇒ extract the missing
//      required field names.
//
// Best-effort and read-only: the probe only ever sends an empty/minimal request.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProbeOptions {
  baseUrl:    string;
  path:       string;
  method:     HttpMethod;
  apiKey?:    string;
  apiSecret?: string;
}

const TIMEOUT = 8_000;

export async function probeEndpoint(opts: ProbeOptions): Promise<ProbeResult> {
  const fromSpec = await tryOpenApi(opts).catch(() => null);
  if (fromSpec && fromSpec.fields.length > 0) return fromSpec;
  // Spec found but no required params is still a useful (authoritative) answer.
  if (fromSpec) return fromSpec;
  return liveProbe(opts);
}

// ── OpenAPI / Swagger ───────────────────────────────────────────────────────

async function tryOpenApi(opts: ProbeOptions): Promise<ProbeResult | null> {
  const base   = opts.baseUrl.replace(/\/$/, '');
  let   origin = base;
  try { origin = new URL(base).origin; } catch { /* base may already be origin */ }

  const candidates = [
    `${base}/openapi.json`, `${base}/swagger.json`, `${base}/openapi`,
    `${base}/swagger/v1/swagger.json`, `${base}/api-docs`, `${base}/v3/api-docs`,
    `${origin}/openapi.json`, `${origin}/swagger.json`,
  ];

  for (const url of candidates) {
    try {
      const r = await axios.get(url, { timeout: TIMEOUT, validateStatus: s => s < 500 });
      const spec = r.data as OpenApiSpec | undefined;
      if (r.status !== 200 || !spec || typeof spec !== 'object' || !spec.paths) continue;

      const discovered = discoverFromSpec(spec, opts.path, opts.method);
      if (!discovered) continue;
      return { ok: true, source: 'openapi', ...discovered,
               message: `Imported from OpenAPI spec at ${url}` };
    } catch { /* try next candidate */ }
  }
  return null;
}

interface OpenApiParam { name: string; in: string; required?: boolean; description?: string; example?: unknown;
  schema?: { example?: unknown }; }
interface OpenApiOperation {
  parameters?: OpenApiParam[];
  requestBody?: { content?: Record<string, { schema?: OpenApiSchema }> };
  security?: unknown[];
}
interface OpenApiSchema { required?: string[]; properties?: Record<string, { description?: string; example?: unknown }>; }
interface OpenApiSpec { paths?: Record<string, Record<string, OpenApiOperation>>; security?: unknown[]; }

// Pure: given a parsed spec, return the required fields + auth flag for an
// endpoint, or null if the spec doesn't describe it. Exported for testing.
export function discoverFromSpec(
  spec: OpenApiSpec, path: string, method: HttpMethod,
): { fields: DiscoveredField[]; authRequired: boolean } | null {
  const op = findOperation(spec, path, method);
  if (!op) return null;
  return { fields: openApiFields(op), authRequired: needsAuth(spec, op) };
}

// Match our concrete path to a (possibly templated) spec path, e.g.
// "/orders/123/status" matches "/orders/{id}/status".
function findOperation(spec: OpenApiSpec, path: string, method: HttpMethod): OpenApiOperation | null {
  const want = segments(path);
  const m    = method.toLowerCase();
  for (const [specPath, ops] of Object.entries(spec.paths ?? {})) {
    const have = segments(specPath);
    if (have.length !== want.length) continue;
    const matches = have.every((seg, i) => seg.startsWith('{') || seg === want[i]);
    if (matches && ops[m]) return ops[m];
  }
  return null;
}

function segments(p: string): string[] {
  return p.replace(/^https?:\/\/[^/]+/, '').split('?')[0].split('/').filter(Boolean);
}

function openApiFields(op: OpenApiOperation): DiscoveredField[] {
  const out: DiscoveredField[] = [];
  for (const p of op.parameters ?? []) {
    if (!p.required) continue;
    if (p.in === 'path') continue; // path params are part of the URL, not a pop-up field
    out.push({
      name: p.name,
      in: p.in === 'header' ? 'header' : 'query',
      required: true,
      description: p.description,
      example: stringifyExample(p.example ?? p.schema?.example),
    });
  }
  const jsonSchema = op.requestBody?.content?.['application/json']?.schema;
  for (const name of jsonSchema?.required ?? []) {
    const prop = jsonSchema?.properties?.[name];
    out.push({ name, in: 'body', required: true, description: prop?.description, example: stringifyExample(prop?.example) });
  }
  return out;
}

function needsAuth(spec: OpenApiSpec, op: OpenApiOperation): boolean {
  const sec = op.security ?? spec.security;
  return Array.isArray(sec) && sec.length > 0;
}

function stringifyExample(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

// ── Live probe ──────────────────────────────────────────────────────────────

async function liveProbe(opts: ProbeOptions): Promise<ProbeResult> {
  const url = `${opts.baseUrl.replace(/\/$/, '')}${opts.path.startsWith('/') ? '' : '/'}${opts.path}`;
  const headers: Record<string, string> = {};
  if (opts.apiKey)    headers['Authorization'] = `Bearer ${opts.apiKey}`;
  if (opts.apiSecret) headers['X-Api-Secret']  = opts.apiSecret;

  const isWrite = opts.method !== 'GET';
  try {
    const r = await axios.request({
      url, method: opts.method, headers,
      data: isWrite ? {} : undefined,
      timeout: TIMEOUT,
      validateStatus: () => true, // we read error responses on purpose
    });

    if (r.status === 401 || r.status === 403) {
      return {
        ok: true, source: 'probe', authRequired: true, sampleStatus: r.status,
        fields: opts.apiKey ? [] : [{ name: 'apiKey', in: 'header', required: true,
          description: 'This endpoint rejected the request as unauthorized — an API key / token is required.' }],
        message: `Endpoint requires authentication (HTTP ${r.status}).`,
      };
    }

    if (r.status === 400 || r.status === 422) {
      const fields = extractRequiredFields(r.data, isWrite ? 'body' : 'query');
      return {
        ok: true, source: 'probe', authRequired: false, sampleStatus: r.status, fields,
        message: fields.length
          ? `Endpoint reported ${fields.length} required field(s).`
          : `Endpoint returned HTTP ${r.status} but no machine-readable field list — you may need to add params manually.`,
      };
    }

    return {
      ok: true, source: 'probe', authRequired: false, sampleStatus: r.status, fields: [],
      message: `Endpoint reachable (HTTP ${r.status}); no required params detected.`,
    };
  } catch (err) {
    return {
      ok: false, source: 'none', authRequired: false, fields: [],
      message: `Could not reach the endpoint: ${(err as Error).message}`,
    };
  }
}

// Extract required-field names from common JSON error shapes. Exported for testing.
export function extractRequiredFields(data: unknown, where: 'query' | 'body'): DiscoveredField[] {
  if (!data || typeof data !== 'object') return [];
  const body = data as Record<string, unknown>;
  const names = new Set<string>();

  // Laravel / Foodics: { message, errors: { field: ["The field is required."] } }
  const errs = body.errors;
  if (errs && typeof errs === 'object' && !Array.isArray(errs)) {
    for (const [field, msgs] of Object.entries(errs as Record<string, unknown>)) {
      if (mentionsRequired(msgs)) names.add(field);
    }
  }

  // JSON:API: { errors: [{ source: { parameter | pointer }, detail }] }
  if (Array.isArray(errs)) {
    for (const e of errs as Array<Record<string, unknown>>) {
      const src = e.source as Record<string, unknown> | undefined;
      const name = (src?.parameter as string)
        ?? lastSegment(src?.pointer as string | undefined);
      if (name && mentionsRequired(e.detail ?? e.title ?? '')) names.add(name);
    }
  }

  return [...names].map(name => ({ name, in: where, required: true,
    description: 'Reported as required by the API.' }));
}

function mentionsRequired(v: unknown): boolean {
  const text = Array.isArray(v) ? v.join(' ') : String(v ?? '');
  // "...is required", "missing", "mandatory", and "(must not|cannot) be blank/null/empty".
  return /requir|missing|mandatory|be (null|blank|empty)/i.test(text) || text === '';
}

function lastSegment(pointer?: string): string | undefined {
  if (!pointer) return undefined;
  const parts = pointer.split('/').filter(Boolean);
  return parts[parts.length - 1];
}
