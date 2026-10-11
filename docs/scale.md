# Scale Notes (W-01)

## Worker split by queue class

- **heavy**: `crawl` (audit/crawl work) — `WORKER_HEAVY_CONCURRENCY` (default 6)
- **light**: `rank-check`, `keyword-refresh`, `geo-check`, `report`, `content` — `WORKER_LIGHT_CONCURRENCY` (default 3)

Heavy work can no longer starve light checks, and light bursts cannot steal
all crawl slots.

## Per-tenant fairness (extends C-03)

- Enqueue-side: per-tenant token bucket 10/min/queue (existing, `enqueue()`).
- Execution-side (new, W-01): a Redis semaphore bounds each tenant to
  **2 concurrent heavy jobs** (`services/fairness.ts`). Losing the race
  moves the job to delayed (+60s) instead of failing or blocking a worker
  slot; slots carry a 15-min TTL so a crashed worker cannot wedge a tenant.

## Cost guardrails

- Per-tenant paid-data budgets (existing, `assertDataBudget`, 402).
- **Global daily provider circuit (new, W-01)**: `assertGlobalProviderBudget()`
  throws 503 `PROVIDER_BUDGET_EXCEEDED` when the UTC-day's total
  `provider_spend` hits `GLOBAL_PROVIDER_DAILY_CAP_UNITS` /
  `GLOBAL_PROVIDER_DAILY_CAP_CENTS` (both 0 = disabled). Wired into every
  provider-cache miss path (keyword metrics, SERP, snapshots). Cached data
  stays available while the circuit is open.
- Redis circuit breakers on providers (existing, C-03).

## Load proof

`npx tsx scripts/load-proof.ts [tenants] [keywordsPerTenant]` — enqueues
real rank-check jobs across N tenants against real Postgres + Redis and
processes them with the production processor (mock provider, labeled).

Honesty: 10k real sites is not feasible on this VM; the script runs at a
sustained-clean scale and reports measured throughput + fairness evidence.
Results from 2026-10-11 are in the final Wave-3 report; the script prints
the full JSON.

## Hardware guidance (rough, for the 10k-site target)

- API: 2× 2 vCPU / 4 GB behind a load balancer; Postgres 16 with
  `max_connections ≥ 200`, `statement_timeout` enabled via
  `DB_STATEMENT_TIMEOUT_MS` (see W-08).
- Workers: scale `crawl` workers horizontally (stateless, BullMQ);
  Redis 7 for queues/rate limits; read replicas for dashboard reads when
  `rank_checks` exceeds ~50M rows (partition by `checked_at` then).
