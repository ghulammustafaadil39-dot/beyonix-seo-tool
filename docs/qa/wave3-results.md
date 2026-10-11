# Wave 3 QA/Release results (QA/Release Lead)

Date: 2026-10-11. Branch: `agent/qa/wave3`. Worktree:
`~/workspace/beyonix-seo-tool/.worktrees/qa3`. All suite numbers from native
Postgres 16 + Redis 7 on localhost.

## Environment notes

- QA test DB: `bseo_test_qa`, bootstrapped via `~/workspace/.local/qa-env.sh`
  (adapts the Backend-A self-healing pattern for VM snapshot reverts: fixed
  dev-only password `bseo_local_dev_pw`, re-asserted before every run).
  Documented in RUNBOOK.md.
- E2E used an isolated DB `bseo_test_e2e` (seeded via `npm run seed`) so the
  coverage run (on `bseo_test_qa`) could not collide with it — a collision
  was observed once (unit tests truncate shared tables; the seeded demo user
  vanished mid-E2E).
- `npm audit` blocked locally by registry policy (`policy_denied`) — CI covers it.
- Docker daemon absent (user decision) — compose files + Trivy are config-only.

## Q-01(a) — integration-stripe populated (BUG-QA-W2-3) ✅

`backend/tests/integration/stripe/stripe-webhook.test.ts`: **11/11 pass**.
Real Stripe SDK signature verification (fake test-mode keys; offline HMAC,
no network). Every payload is a genuine Stripe envelope
`{id, object:'event', type, created, data:{object:{...}}}` — the parity
BUG-QA-W2-2 fixed on the mock path. Covers: checkout.session.completed →
subscription + plan + period FROM Stripe, redelivery dedup, subscription.updated
price→plan mapping, invoice.paid row, subscription.deleted → starter,
tampered payload rejected, wrong-secret rejected, unsigned rejected,
mock/real envelope parity (2 unit tests). Run:
`npx vitest run --project integration-stripe`.

## Q-01(b) — coverage ✅ TARGET MET

`npm run test:coverage` (v8; core scope = `src/services/**`,
`src/routes/**`, `src/metering.ts`, `src/plans.ts`, `src/config.ts`):
**85.34% lines / 85.34% stmts / 93.67% funcs / 79.81% branches**
(63 files, 606 passed / 9 skipped / 0 failed in the coverage run).

Path: baseline 82.9% → +2.4pts from real gap tests, not padding:
- `tests/wave3/q01-coverage-gaps.test.ts` (8 tests): on-page analysis
  end-to-end (routes/onpage.ts 32→80%), backlink refresh processor
  (backlinkJobs 8→66%), weekly re-verify processor paths.
- `tests/wave3/q01-coverage-gaps2.test.ts` (6 tests): content processor
  (generate→review, idempotent skip, ai_words cost-guard skip) and report
  processor (build + idempotent re-run + email).

Remaining honest gaps (all worker-processor/notification plumbing, covered
by job-level tests elsewhere): keywordJobs 18.8%, geoJobs 20.4%,
notifications.ts 45.8%, services/billing.ts 55.7%, crawlJobs 56.5%,
routes/sites.ts 65.2%, routes/ga4.ts 68.2%. Recommended for Wave-4/audit
follow-up, not blockers.

## Q-01(c) — Playwright E2E ✅

Chromium installed via `npx playwright-core install chromium`
(`/home/hatch/.cache/ms-playwright/chromium-1248`, headless-shell too);
launches with `--no-sandbox` (default launch hangs in this VM — dbus/sandbox
issue; exact probe: raw `chrome --headless --dump-dom about:blank` prints
dbus errors but works; playwright launch needed `--no-sandbox,--disable-gpu`).

`backend/tests/e2e/journeys.mjs` — **5/5 PASS** against built frontend
(`next build` + `next start`, 30 routes incl. new `/status`) + built API +
seeded DB (`bseo_test_e2e`):
1. login (demo@beyonix.local) → dashboard shows seeded site `example.com`
2. `/dashboard/billing` renders subscription data
3. logout → login again (P0-01 UI regression)
4. signup fresh user → `/dashboard`
5. `/status` page renders live service data

One debugging note: an early E2E run failed 2/5 because the run shared the
coverage-run DB (demo user truncated) and a `waitForURL(/\/login|\//)` regex
matched any path — both test-side issues, fixed.

## Q-01(d) — load ✅

`backend/tests/load/hot-reads.load.mjs` (Node fallback — k6 not installed in
this VM): 50 concurrent VUs × 5 hot read endpoints × 2 min, against the API
with rate limits lifted (baseline config) on `bseo_test_e2e`:

- **88,479 requests, 0 errors, error rate 0 — PASS**
- overall p50 50.5ms / **p95 184.9ms** / p99 287ms
- per endpoint: /healthz p95 80ms, /api/v1/auth/me p95 82ms,
  /readyz p95 123ms, /metrics p95 225ms, /status p95 248ms
  (`/metrics`/`/status` read BullMQ counts for 7 queues + Postgres live —
  the slower two are the instrumented ones, still well under budget)

With production rate limits (300 req/min/IP) the same script fails at 99.7%
error rate (HTTP 429/500 "Rate limit exceeded") — expected: 50 VUs hammering
at ~737 req/s is not a realistic user pattern; the limit is per-IP, so 50
real browsers behind different IPs would each get their own 300/min budget.
Both numbers are reported honestly.

## Q-01(e) — accessibility (axe) ✅ ran, findings filed

`backend/tests/e2e/axe.mjs` (@axe-core/playwright, Chromium):
- `/login`, `/signup`: 1 critical — `label` rule: inputs have sibling
  `<label>` elements not associated via `htmlFor`/`id` (2 and 3 nodes).
- `/dashboard`: 0 violations.
- `/dashboard/billing`: 1 serious — `color-contrast` (14 nodes, dark theme).
- `/status` (new, QA): 1 serious — `color-contrast` (3 nodes, `text-gray-500`).

→ Reported to parent/LA; fixes belong to the Frontend brief (UI-owned).

## Q-02 CI ✅ (config)

`.github/workflows/ci.yml` added — jobs: backend-lint-typecheck, backend-tests
(PG+Redis services, all 3 vitest projects), coverage gate (core ≥85%),
frontend-build, migration-dry-run, npm-audit, secret-scan (gitleaks +
`.gitleaks.toml`), e2e-smoke. YAML-validated locally with PyYAML; never
executed here (GitHub Actions only). CI badge + CI↔local command map in
RUNBOOK.md. Existing `trivy.yml` kept (config-only; no daemon here).

## Q-03 observability ✅

- API: Fastify built-in **pino** JSON logs; request id generated per request,
  echoed as `x-request-id`, present in every error body (`error.requestId`),
  attached to pino records as `requestId`. Verified by
  `tests/wave3/q03-observability.test.ts`.
- `GET /metrics` (Prometheus text): `bseo_http_requests_total`,
  `bseo_http_request_duration_ms` histogram, `bseo_job_outcomes_total`
  (wired in worker.ts), live `bseo_queue_jobs`, `bseo_provider_spend_cents_30d`
  (from `provider_spend`), `bseo_dead_letters_pending`, `bseo_uptime_seconds`.
  No tenant ids/emails in labels.
- `GET /status` JSON + `/status` page (server component, accessible table).
- Sentry/OTel: env-gated hook points (`SENTRY_DSN`,
  `OTEL_EXPORTER_OTLP_ENDPOINT`), no hard dependency; reported in
  `/status.hooks`. Example alert rules in `docs/observability.md`.
- Honest gap: worker logs are still `console.*` (no pino, no request-id
  propagation API→worker) — documented in `docs/observability.md`;
  recommended as a Backend follow-up.

## Q-04 docs ✅

README rewritten to the real product (old "Deferred to v2" list was
superseded by the master-prompt program); ARCHITECTURE.md §13 added;
RUNBOOK.md new (ops, qa-env.sh, key rotation, zero-downtime, env reference,
CI↔local map, CI badge); `docs/methodology.md` new (score formulas read from
code: audit `100-min(90,Σweights)` error=10/warning=4/info=1, GEO simulation
honesty, PageSpeed caching, mock table); CONTRIBUTING.md, SECURITY.md,
CHANGELOG.md (seeded from git history); `.env.example` complete — proven by
grepping all 47 `opt()` vars in `config.ts` + live `process.env` reads
(gaps fixed: `CMS_PUBLISH_ENABLED`, `NEXT_PUBLIC_SITE_URL`,
`PAGESPEED_DAILY_QUOTA` added; `PAGESPEED_API_KEY` was documented-but-unread
and was removed).

## Q-05 prod deploy config ✅ (static only)

`docker-compose.prod.yml` (api/worker/web/frontend + postgres/redis +
Caddy TLS + nightly backup sidecar; healthchecks, `unless-stopped`, resource
limits, log rotation, `:?` secret guards) + `Caddyfile.prod`. YAML-validated;
**never booted — no Docker daemon in this environment** (user decision).
Scheduler intentionally NOT split into its own service (W-01 Backend split
pending — compose says so explicitly rather than inventing an entry point).

## W-09 (QA slice) ✅

- `backend/scripts/seed.ts`: idempotent demo data (demo tenant + verified
  owner + verified site + keywords + completed audit with issues + report);
  refuses production unless `SEED_DEMO=1`; `npm run seed` added. Verified by
  running it against `bseo_test_e2e` and logging in via the UI (E2E journey 1).
- `Makefile`: `make dev` (install → migrate → seed → API+worker+web),
  `make test`, `make coverage`, `make load`. README documents it.
- Strict-TS/ESLint/OpenAPI-client slices belong to Backend/Frontend briefs
  (not done here).

## Suite status at report time

- Full suite (no coverage), final run on `agent/qa/wave3`: **63 files,
  606 passed / 9 skipped / 0 failed** (Wave-2 baseline on main was
  577/9/0; +29 = 11 stripe + 4 observability + 8 gap + 6 gap2).
  Backend `tsc --noEmit` clean; frontend `tsc --noEmit` clean;
  `next build` green (30 routes, incl. new `/status`).
- Chaos-test note (resolved): `tests/wave2/journey-chaos.test.ts` (3 tests)
  failed twice during Wave 3 — both times root-caused as **test-DB
  contention from my own concurrent runs** (a second suite truncating the
  shared `bseo_test_qa` mid-run, and once a V8-coverage-slowed run against
  a loaded VM), never a code regression. Solo re-run on this branch:
  **3/3 pass**. Standing rule: never run two suites against the same test
  DB concurrently.
