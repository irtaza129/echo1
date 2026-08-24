/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║                    ECHO1 LOAD TEST — 100 PARALLEL REQUESTS         ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║  Fires 100 concurrent requests across multiple endpoint categories ║
 * ║  to stress-test the system for crashes, timeouts, and rate limits.  ║
 * ║                                                                    ║
 * ║  Usage:  npx tsx testing/load-test.ts                                      ║
 * ║          npx tsx testing/load-test.ts --url https://your-deployed-url.com  ║
 * ║          npx tsx testing/load-test.ts --rounds 3                           ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import crypto from 'crypto';

// ── Configuration ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const BASE_URL       = getArg('url', 'http://localhost:3000').replace(/\/$/, '');
const TOTAL_REQUESTS = parseInt(getArg('requests', '100'), 10);
const ROUNDS         = parseInt(getArg('rounds', '1'), 10);
const TIMEOUT_MS     = 15_000;

// ── Color helpers (ANSI) ─────────────────────────────────────────────────────

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  bgRed:   '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow:'\x1b[43m',
};

// ── Types ────────────────────────────────────────────────────────────────────

interface RequestResult {
  id:           number;
  endpoint:     string;
  method:       string;
  category:     string;
  status:       number | 'TIMEOUT' | 'ERROR';
  latencyMs:    number;
  error?:       string;
  bodyPreview?: string;
}

interface RoundReport {
  round:           number;
  totalRequests:   number;
  successful:      number;   // 2xx
  clientErrors:    number;   // 4xx (expected: rate limits, auth failures)
  serverErrors:    number;   // 5xx (bad — potential crashes)
  timeouts:        number;
  networkErrors:   number;
  avgLatencyMs:    number;
  p50LatencyMs:    number;
  p95LatencyMs:    number;
  p99LatencyMs:    number;
  maxLatencyMs:    number;
  minLatencyMs:    number;
  rps:             number;   // requests per second
  durationMs:      number;
}

// ── Request definitions ──────────────────────────────────────────────────────

interface EndpointDef {
  method:   'GET' | 'POST';
  path:     string;
  category: string;
  body?:    Record<string, unknown>;
  headers?: Record<string, string>;
}

function buildEndpoints(): EndpointDef[] {
  const defs: EndpointDef[] = [];

  // ── PUBLIC endpoints (no auth needed) ──────────────────────────────────────
  // Tenant config — the most hit public endpoint
  for (let i = 0; i < 25; i++) {
    defs.push({
      method: 'GET',
      path: '/api/tenant-config/savour-foods',
      category: 'public',
    });
  }

  // Non-existent tenant (should 404 gracefully)
  for (let i = 0; i < 5; i++) {
    defs.push({
      method: 'GET',
      path: `/api/tenant-config/nonexistent-tenant-${i}`,
      category: 'public',
    });
  }

  // ── AUTH endpoints (test login flood) ──────────────────────────────────────
  // Valid login attempts
  for (let i = 0; i < 10; i++) {
    defs.push({
      method: 'POST',
      path: '/api/auth/login',
      category: 'auth',
      body: { username: 'agent1101', password: 'wrongpassword' },
    });
  }

  // Invalid payloads (should 400 gracefully)
  for (let i = 0; i < 5; i++) {
    defs.push({
      method: 'POST',
      path: '/api/auth/login',
      category: 'auth',
      body: {},
    });
  }

  // Token verification with garbage tokens
  for (let i = 0; i < 5; i++) {
    defs.push({
      method: 'POST',
      path: '/api/auth/verify',
      category: 'auth',
      body: { token: crypto.randomBytes(32).toString('hex') },
    });
  }

  // Registration attempts (should 400 or 409)
  for (let i = 0; i < 5; i++) {
    defs.push({
      method: 'POST',
      path: '/api/auth/register',
      category: 'auth',
      body: {
        email: `loadtest-${i}@test.com`,
        password: 'short',  // too short — should 400
        restaurantName: `Load Test ${i}`,
        slug: `load-test-${i}`,
      },
    });
  }

  // ── AGENT endpoints (menu context, orders) ─────────────────────────────────
  for (let i = 0; i < 15; i++) {
    defs.push({
      method: 'GET',
      path: '/api/agent/menu-context',
      category: 'agent',
      headers: { 'X-Tenant-ID': '00000000-0000-4000-8000-000000000001' },
    });
  }

  // ── ADMIN endpoints (expect 401 — testing unauthorized flood) ──────────────
  for (let i = 0; i < 10; i++) {
    defs.push({
      method: 'GET',
      path: '/api/admin/my-config',
      category: 'admin-unauth',
    });
  }

  for (let i = 0; i < 5; i++) {
    defs.push({
      method: 'GET',
      path: '/api/admin/menu',
      category: 'admin-unauth',
    });
  }

  for (let i = 0; i < 5; i++) {
    defs.push({
      method: 'GET',
      path: '/api/admin/audit-log',
      category: 'admin-unauth',
    });
  }

  // ── GEMINI TOKEN endpoint (expect failure or rate limit) ───────────────────
  for (let i = 0; i < 5; i++) {
    defs.push({
      method: 'POST',
      path: '/api/gemini-token',
      category: 'gemini',
    });
  }

  // ── MALFORMED / edge-case requests ─────────────────────────────────────────
  for (let i = 0; i < 5; i++) {
    defs.push({
      method: 'POST',
      path: '/api/admin/save-config',
      category: 'edge-case',
      body: { garbage: 'data', [crypto.randomBytes(8).toString('hex')]: true },
    });
  }

  // Pad or trim to exact total
  while (defs.length < TOTAL_REQUESTS) {
    defs.push({
      method: 'GET',
      path: '/api/tenant-config/savour-foods',
      category: 'public',
    });
  }

  return defs.slice(0, TOTAL_REQUESTS);
}

// ── Single request executor ──────────────────────────────────────────────────

async function fireRequest(id: number, def: EndpointDef): Promise<RequestResult> {
  const url = `${BASE_URL}${def.path}`;
  const start = performance.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...def.headers,
    };

    const resp = await fetch(url, {
      method: def.method,
      headers,
      body: def.body ? JSON.stringify(def.body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timer);
    const latencyMs = Math.round(performance.now() - start);

    let bodyPreview = '';
    try {
      const text = await resp.text();
      bodyPreview = text.slice(0, 200);
    } catch { /* body read failed — non-fatal */ }

    return {
      id,
      endpoint: `${def.method} ${def.path}`,
      method: def.method,
      category: def.category,
      status: resp.status,
      latencyMs,
      bodyPreview,
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    const latencyMs = Math.round(performance.now() - start);
    const errMsg = err instanceof Error ? err.message : String(err);

    if (errMsg.includes('abort') || errMsg.includes('timeout')) {
      return {
        id,
        endpoint: `${def.method} ${def.path}`,
        method: def.method,
        category: def.category,
        status: 'TIMEOUT',
        latencyMs,
        error: `Timeout after ${TIMEOUT_MS}ms`,
      };
    }

    return {
      id,
      endpoint: `${def.method} ${def.path}`,
      method: def.method,
      category: def.category,
      status: 'ERROR',
      latencyMs,
      error: errMsg,
    };
  }
}

// ── Percentile helper ────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Report generation ────────────────────────────────────────────────────────

function analyzeResults(round: number, results: RequestResult[], durationMs: number): RoundReport {
  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);

  const successful    = results.filter(r => typeof r.status === 'number' && r.status >= 200 && r.status < 300).length;
  const clientErrors  = results.filter(r => typeof r.status === 'number' && r.status >= 400 && r.status < 500).length;
  const serverErrors  = results.filter(r => typeof r.status === 'number' && r.status >= 500).length;
  const timeouts      = results.filter(r => r.status === 'TIMEOUT').length;
  const networkErrors = results.filter(r => r.status === 'ERROR').length;

  return {
    round,
    totalRequests: results.length,
    successful,
    clientErrors,
    serverErrors,
    timeouts,
    networkErrors,
    avgLatencyMs:  Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    p50LatencyMs:  percentile(latencies, 50),
    p95LatencyMs:  percentile(latencies, 95),
    p99LatencyMs:  percentile(latencies, 99),
    maxLatencyMs:  latencies[latencies.length - 1] ?? 0,
    minLatencyMs:  latencies[0] ?? 0,
    rps:           Math.round((results.length / durationMs) * 1000 * 100) / 100,
    durationMs:    Math.round(durationMs),
  };
}

function printReport(report: RoundReport, results: RequestResult[]) {
  console.log('\n' + '═'.repeat(72));
  console.log(`${c.bold}${c.cyan}  ⚡ ROUND ${report.round} — LOAD TEST RESULTS${c.reset}`);
  console.log('═'.repeat(72));

  // ── Overview ────────────────────────
  console.log(`\n${c.bold}  📊 Overview${c.reset}`);
  console.log(`  ├─ Total Requests:   ${c.bold}${report.totalRequests}${c.reset}`);
  console.log(`  ├─ Duration:         ${c.bold}${report.durationMs}ms${c.reset}`);
  console.log(`  └─ Throughput:       ${c.bold}${report.rps} req/s${c.reset}`);

  // ── Status breakdown ────────────────
  console.log(`\n${c.bold}  📈 Status Breakdown${c.reset}`);
  console.log(`  ├─ ${c.green}✓ 2xx Success:${c.reset}     ${report.successful}`);
  console.log(`  ├─ ${c.yellow}⚠ 4xx Client Err:${c.reset}  ${report.clientErrors}  ${c.dim}(rate limits, auth, validation)${c.reset}`);
  console.log(`  ├─ ${c.red}✗ 5xx Server Err:${c.reset}  ${report.serverErrors}  ${report.serverErrors > 0 ? c.bgRed + c.white + ' POTENTIAL CRASH ' + c.reset : ''}`);
  console.log(`  ├─ ${c.magenta}⏱ Timeouts:${c.reset}       ${report.timeouts}`);
  console.log(`  └─ ${c.red}🔌 Network Err:${c.reset}    ${report.networkErrors}  ${report.networkErrors > 0 ? c.bgRed + c.white + ' SERVER DOWN? ' + c.reset : ''}`);

  // ── Latency ─────────────────────────
  console.log(`\n${c.bold}  ⏱  Latency Distribution${c.reset}`);
  console.log(`  ├─ Min:    ${c.green}${report.minLatencyMs}ms${c.reset}`);
  console.log(`  ├─ P50:    ${report.p50LatencyMs}ms`);
  console.log(`  ├─ Avg:    ${report.avgLatencyMs}ms`);
  console.log(`  ├─ P95:    ${report.p95LatencyMs > 3000 ? c.yellow : ''}${report.p95LatencyMs}ms${c.reset}`);
  console.log(`  ├─ P99:    ${report.p99LatencyMs > 5000 ? c.red : ''}${report.p99LatencyMs}ms${c.reset}`);
  console.log(`  └─ Max:    ${report.maxLatencyMs > 10000 ? c.red : c.yellow}${report.maxLatencyMs}ms${c.reset}`);

  // ── Per-category breakdown ──────────
  const categories = [...new Set(results.map(r => r.category))];
  console.log(`\n${c.bold}  📂 Per-Category Breakdown${c.reset}`);
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const ok  = catResults.filter(r => typeof r.status === 'number' && r.status < 400).length;
    const err = catResults.filter(r => typeof r.status === 'number' && r.status >= 500).length;
    const rl  = catResults.filter(r => r.status === 429).length;
    const avgMs = Math.round(catResults.reduce((a, r) => a + r.latencyMs, 0) / catResults.length);
    const icon = err > 0 ? `${c.red}✗` : rl > 0 ? `${c.yellow}⚠` : `${c.green}✓`;
    console.log(`  ${icon} ${c.bold}${cat}${c.reset}  (${catResults.length} reqs)  ok=${ok}  5xx=${err}  429=${rl}  avg=${avgMs}ms`);
  }

  // ── Server errors detail ────────────
  const serverErrs = results.filter(r => typeof r.status === 'number' && r.status >= 500);
  if (serverErrs.length > 0) {
    console.log(`\n${c.bold}${c.red}  🚨 SERVER ERROR DETAILS${c.reset}`);
    for (const r of serverErrs.slice(0, 10)) {
      console.log(`  ${c.red}[${r.status}]${c.reset} ${r.endpoint}`);
      if (r.bodyPreview) console.log(`        ${c.dim}${r.bodyPreview.slice(0, 120)}${c.reset}`);
    }
    if (serverErrs.length > 10) console.log(`  ... and ${serverErrs.length - 10} more`);
  }

  // ── Timeouts detail ─────────────────
  const timeoutResults = results.filter(r => r.status === 'TIMEOUT');
  if (timeoutResults.length > 0) {
    console.log(`\n${c.bold}${c.magenta}  ⏱  TIMEOUT DETAILS${c.reset}`);
    for (const r of timeoutResults.slice(0, 5)) {
      console.log(`  ${c.magenta}[TIMEOUT]${c.reset} ${r.endpoint}  (${r.latencyMs}ms)`);
    }
    if (timeoutResults.length > 5) console.log(`  ... and ${timeoutResults.length - 5} more`);
  }

  // ── Network errors detail ───────────
  const netErrs = results.filter(r => r.status === 'ERROR');
  if (netErrs.length > 0) {
    console.log(`\n${c.bold}${c.red}  🔌 NETWORK ERROR DETAILS${c.reset}`);
    for (const r of netErrs.slice(0, 5)) {
      console.log(`  ${c.red}[ERROR]${c.reset} ${r.endpoint}: ${r.error}`);
    }
    if (netErrs.length > 5) console.log(`  ... and ${netErrs.length - 5} more`);
  }

  // ── Rate limit analysis ─────────────
  const rateLimited = results.filter(r => r.status === 429);
  if (rateLimited.length > 0) {
    console.log(`\n${c.bold}${c.yellow}  🛡️  Rate Limiting Triggered${c.reset}`);
    console.log(`  ${rateLimited.length} requests received 429 Too Many Requests`);
    const rlCategories = [...new Set(rateLimited.map(r => r.category))];
    for (const cat of rlCategories) {
      const count = rateLimited.filter(r => r.category === cat).length;
      console.log(`    └─ ${cat}: ${count} rate-limited`);
    }
  }
}

function printVerdict(reports: RoundReport[]) {
  const totalServerErrors  = reports.reduce((a, r) => a + r.serverErrors, 0);
  const totalNetworkErrors = reports.reduce((a, r) => a + r.networkErrors, 0);
  const totalTimeouts      = reports.reduce((a, r) => a + r.timeouts, 0);
  const totalRequests      = reports.reduce((a, r) => a + r.totalRequests, 0);
  const avgRps             = Math.round(reports.reduce((a, r) => a + r.rps, 0) / reports.length * 100) / 100;

  console.log('\n' + '═'.repeat(72));
  console.log(`${c.bold}${c.cyan}  🏁 FINAL VERDICT${c.reset}`);
  console.log('═'.repeat(72));
  console.log(`  Total Requests Fired: ${c.bold}${totalRequests}${c.reset} across ${reports.length} round(s)`);
  console.log(`  Average Throughput:   ${c.bold}${avgRps} req/s${c.reset}`);

  if (totalNetworkErrors > 0) {
    console.log(`\n  ${c.bgRed}${c.white}${c.bold}  💀  SYSTEM CRASHED  ${c.reset}`);
    console.log(`  ${c.red}${totalNetworkErrors} network errors detected — the server likely went down!${c.reset}`);
    console.log(`  ${c.red}The server could not handle ${totalRequests} concurrent requests.${c.reset}`);
  } else if (totalServerErrors > 5) {
    console.log(`\n  ${c.bgRed}${c.white}${c.bold}  ⚠️  UNSTABLE  ${c.reset}`);
    console.log(`  ${c.red}${totalServerErrors} server errors (5xx) — system is struggling under load.${c.reset}`);
    console.log(`  ${c.yellow}Review server logs for stack traces and resource exhaustion.${c.reset}`);
  } else if (totalServerErrors > 0) {
    console.log(`\n  ${c.bgYellow}${c.bold}  ⚡  MOSTLY STABLE  ${c.reset}`);
    console.log(`  ${c.yellow}${totalServerErrors} minor server error(s) detected — may need investigation.${c.reset}`);
  } else if (totalTimeouts > totalRequests * 0.1) {
    console.log(`\n  ${c.bgYellow}${c.bold}  ⏱  SLOW BUT ALIVE  ${c.reset}`);
    console.log(`  ${c.yellow}No crashes, but ${totalTimeouts} timeouts (${Math.round(totalTimeouts / totalRequests * 100)}%) suggest performance issues.${c.reset}`);
  } else {
    console.log(`\n  ${c.bgGreen}${c.bold}  ✅  SYSTEM IS STABLE  ${c.reset}`);
    console.log(`  ${c.green}No crashes, no server errors. System handled ${totalRequests} parallel requests gracefully.${c.reset}`);
    if (totalTimeouts > 0) {
      console.log(`  ${c.dim}(${totalTimeouts} timeout(s) detected — within acceptable range)${c.reset}`);
    }
  }

  console.log('═'.repeat(72) + '\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(72));
  console.log(`${c.bold}${c.cyan}  ⚡ ECHO1 LOAD TESTER${c.reset}`);
  console.log('═'.repeat(72));
  console.log(`  ${c.dim}Target:${c.reset}     ${c.bold}${BASE_URL}${c.reset}`);
  console.log(`  ${c.dim}Requests:${c.reset}   ${c.bold}${TOTAL_REQUESTS}${c.reset} per round`);
  console.log(`  ${c.dim}Rounds:${c.reset}     ${c.bold}${ROUNDS}${c.reset}`);
  console.log(`  ${c.dim}Timeout:${c.reset}    ${c.bold}${TIMEOUT_MS}ms${c.reset}`);
  console.log('─'.repeat(72));

  // Pre-flight check: is the server reachable?
  console.log(`\n  ${c.dim}🔍 Pre-flight check...${c.reset}`);
  try {
    const resp = await fetch(`${BASE_URL}/api/tenant-config/savour-foods`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      console.log(`  ${c.green}✓ Server is reachable (HTTP ${resp.status})${c.reset}\n`);
    } else {
      console.log(`  ${c.yellow}⚠ Server responded with HTTP ${resp.status} — proceeding anyway${c.reset}\n`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${c.red}✗ Cannot reach server: ${msg}${c.reset}`);
    console.log(`  ${c.red}  Make sure the server is running at ${BASE_URL}${c.reset}`);
    console.log(`  ${c.dim}  Start it with: npm run dev${c.reset}\n`);
    process.exit(1);
  }

  const allReports: RoundReport[] = [];

  for (let round = 1; round <= ROUNDS; round++) {
    if (ROUNDS > 1) {
      console.log(`\n${c.bold}${c.blue}  ── Round ${round} of ${ROUNDS} ──${c.reset}`);
    }

    const endpoints = buildEndpoints();
    console.log(`  🚀 Firing ${endpoints.length} parallel requests...`);

    const roundStart = performance.now();

    // Fire ALL requests in parallel
    const results = await Promise.all(
      endpoints.map((def, idx) => fireRequest(idx + 1, def))
    );

    const roundDuration = performance.now() - roundStart;

    const report = analyzeResults(round, results, roundDuration);
    allReports.push(report);

    printReport(report, results);

    // Small gap between rounds to let the server breathe
    if (round < ROUNDS) {
      console.log(`\n  ${c.dim}⏳ Waiting 2s before next round...${c.reset}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  printVerdict(allReports);
}

main().catch(err => {
  console.error(`\n${c.red}Fatal error: ${err}${c.reset}`);
  process.exit(1);
});
