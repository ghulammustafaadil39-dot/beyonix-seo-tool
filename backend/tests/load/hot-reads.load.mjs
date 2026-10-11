#!/usr/bin/env node
/**
 * Q-01(d): baseline load test — Node fallback for k6 (k6 is not installed
 * in this VM; see docs/qa/wave3-results.md for the exact probe).
 *
 * 50 concurrent virtual users hammer hot READ endpoints for DURATION_MS
 * (default 120000 = 2 min). Each VU loops: GET /healthz, GET /readyz,
 * GET /status, GET /metrics, GET /api/v1/auth/me (401 expected — still a
 * hot auth-middleware path). Reports totals, error rate and p50/p95/p99
 * latency per endpoint + overall.
 *
 * Usage:
 *   API_BASE=http://localhost:4000 CONCURRENCY=50 DURATION_MS=120000 \
 *     node tests/load/hot-reads.load.mjs
 * Exit code 1 when the overall error rate (excluding expected 401s) > 1%
 * or overall p95 > 1000ms, so CI can gate on it if desired.
 */
const BASE = (process.env.API_BASE ?? 'http://localhost:4000').replace(/\/$/, '');
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? '50', 10);
const DURATION_MS = parseInt(process.env.DURATION_MS ?? '120000', 10);

const ENDPOINTS = [
  { path: '/healthz', ok: [200] },
  { path: '/readyz', ok: [200] },
  { path: '/status', ok: [200] },
  { path: '/metrics', ok: [200] },
  { path: '/api/v1/auth/me', ok: [401] },
];

const samples = new Map(ENDPOINTS.map((e) => [e.path, []]));
let errors = 0;
let total = 0;
const deadline = Date.now() + DURATION_MS;

async function vu() {
  while (Date.now() < deadline) {
    for (const ep of ENDPOINTS) {
      if (Date.now() >= deadline) break;
      const t0 = performance.now();
      try {
        const res = await fetch(`${BASE}${ep.path}`);
        await res.arrayBuffer();
        const ms = performance.now() - t0;
        samples.get(ep.path).push(ms);
        total += 1;
        if (!ep.ok.includes(res.status)) errors += 1;
      } catch {
        total += 1;
        errors += 1;
      }
    }
  }
}

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

console.log(`[load] base=${BASE} concurrency=${CONCURRENCY} durationMs=${DURATION_MS}`);
await Promise.all(Array.from({ length: CONCURRENCY }, () => vu()));

const all = [...samples.values()].flat();
const summary = {
  base: BASE,
  concurrency: CONCURRENCY,
  durationMs: DURATION_MS,
  totalRequests: total,
  errors,
  errorRate: total ? +(errors / total).toFixed(4) : 0,
  overall: { p50: +pct(all, 50).toFixed(1), p95: +pct(all, 95).toFixed(1), p99: +pct(all, 99).toFixed(1) },
  perEndpoint: Object.fromEntries(
    [...samples.entries()].map(([path, arr]) => [
      path,
      { n: arr.length, p50: +pct(arr, 50).toFixed(1), p95: +pct(arr, 95).toFixed(1), p99: +pct(arr, 99).toFixed(1) },
    ]),
  ),
};
console.log(JSON.stringify(summary, null, 2));
if (summary.errorRate > 0.01 || summary.overall.p95 > 1000) {
  console.error('[load] FAIL: errorRate>1% or p95>1000ms');
  process.exit(1);
}
console.log('[load] PASS');
