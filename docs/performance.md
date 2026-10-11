# Hot-Endpoint Performance (W-08)

Benchmark: `npx tsx scripts/bench-hot.ts [iterations]` — boots the real app,
seeds 1 tenant / 1 site / 50 tracked keywords × 30 rank checks / 1 audit with
30 issues, then measures 60 iterations of the three hot reads via `inject`
(local, no network).

## Results (2026-10-11, VM, inject timings, n=60)

| Endpoint | before (indexes dropped) | after (migration 040 indexes) |
|---|---|---|
| GET /api/v1/sites | median 3.89ms / p95 18.20ms | median 2.62ms / p95 14.67ms |
| GET /sites/:id/ranks | median 21.26ms / p95 55.70ms | median 18.53ms / p95 24.65ms |
| GET /sites/:id/overview | median 11.86ms / p95 30.60ms | median 3.65ms / p95 6.47ms |

All measured values are far under the 200ms budget. Honest notes: these
are local `inject` timings (no network), on a small dataset (50 keywords ×
30 rank checks, 1 audit with 30 issues); the new composite indexes matter
most at production scale, where the ranks endpoint's per-keyword
`LEFT JOIN LATERAL` over unbounded `rank_checks` history becomes an index
scan instead of a sequential scan.

## What was fixed

- New indexes in migration `040_wave3.sql`: `idx_w3_rank_checks_kw_latest`,
  `idx_w3_audits_site_latest`, `idx_w3_audit_issues_site_status`,
  `idx_w3_keywords_site_tracked`, `idx_w3_provider_spend_day`,
  `idx_w3_usage_tenant_type_time`. The ranks endpoint previously did a
  per-keyword `LEFT JOIN LATERAL` over the full `rank_checks` history and
  a window-function scan for sparklines; the composite
  `(tenant_id, keyword_id, checked_at DESC)` index turns both into index
  scans.
- No new N+1s introduced: overview issues query stays bounded (`LIMIT 5`);
  keyword seeding path unchanged.

## Query budget guardrails

- `DB_STATEMENT_TIMEOUT_MS` (env, default off): when set, every pooled
  connection gets a Postgres `statement_timeout` (see `src/db.ts`). Off by
  default because migrations/index builds legitimately run long — enable
  for API/worker roles in production.
- Response caching: none added on hot reads (data changes per crawl/check;
  the provider caches below them already serve this role).
