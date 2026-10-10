# PROGRESS.md — Program task board (LA-owned; agents report, LA edits)

Spec: `~/workspace/user/files/SEO_TOOL_MASTER_PROMPT_1_yhjl.md` · Plan: `ARCHITECTURE_PLAN.md` · Findings: `AUDIT_RESULT.md`
Status legend: `pending` → `in_progress` → `in_review` → `verified` | `blocked` (reason) | `exception` (LA-justified only)

## Wave 0 — baseline (LA + Audit Lead)

| Item | Status | Evidence |
|---|---|---|
| Repo read; infra native (PG16+Redis7, no Docker daemon) | verified | `psql` 16.15 online, `redis-cli` PONG, DBs `bseo`/`bseo_test` created 2026-10-11 |
| Baseline: `tsc --noEmit` | verified | exit 0, 2026-10-11 |
| Baseline: `npm test` (backend) | verified | 108/108 pass, 7 files, 2026-10-11 |
| Git init + baseline commit | verified | `cc622a6` on `main` |
| ARCHITECTURE_PLAN.md / PROGRESS.md / AUDIT_RESULT.md created | verified | this wave |
| Baseline hostile audit (Audit Lead, read-only) | verified | 22 new findings: 4 high, 11 med, 7 low — all in AUDIT_RESULT.md Wave 0 section, 2026-10-11 |
| Contracts frozen (§3 of plan) | verified | 2026-10-11 |
| Scope: v2-deferrals SUPERSEDED (F-07/F-08/F-09/PDF in scope) | verified | decision recorded 2026-10-11 |

## Wave 1 — Phase 0 + Phase 1 (blockers & security)

| ID | Owner | Wave | Status | Notes / sub-tasks |
|---|---|---|---|---|
| P0-01 | Backend Lead | 1 | pending | Password login vs token_version. Partially? verify + regression test |
| P0-02 | Backend Lead | 1 | pending | Migration advisory lock + tx; one-shot migrate; liveness/readiness split |
| P0-03 | Frontend Lead | 1 | in_review | LA review PASSED + merged to main (b45411d) 2026-10-11. Approved deviation: next.config rewrites bake at build time (verified in standalone server.js) → implemented as catch-all proxy route reading API_INTERNAL_URL per request. tsc 0, next build 0 errors, live standalone smoke vs stub API passed. Docker build not run (no daemon — CI in Wave 3). Gate re-verification pending |
| P0-04 | Backend Lead | 1 | pending | subscription_data.metadata + price→plan map; signed-fixture tests |
| P0-05 | Security Lead | 1 | pending | Prod-safe defaults; Backend Lead supports compose/prod env |
| S-01 | Security Lead | 1 | pending | Email verification flow; Google merge rules |
| S-02 | Security Lead | 1 | pending | SSRF DNS-pinning (safeFetch exists — verify/extend + rebinding tests) |
| S-03 | Security Lead | 1 | pending | trustProxy, Redis rate limits, login lockout |
| S-04 | Security Lead | 1 | pending | OAuth state in Redis + signed cookie + PKCE |
| S-05 | Security Lead | 1 | pending | Password reset/change, email change, delete+purge, TOTP, sessions list |
| S-06 | Security Lead | 1 | pending | Cookies/CSRF/helmet/CSP/CORS allow-list (Frontend Lead: Next.js headers) |
| S-07 | Security Lead | 1 | pending | No base64 fallback in prod; key versioning + rotation script |
| S-08 | Security Lead | 1 | pending | Exact meta-tag parse; TXT exact-match; weekly re-verify |
| S-09 | Security Lead | 1 | pending | Prompt-injection delimiting; LLM HTML sanitization |
| S-10 | Security Lead | 1 | pending | Non-root, read-only FS, pinned digests, no exposed DB/Redis, Trivy in CI |

### Wave 1 additions (from baseline hostile audit 2026-10-11)

| ID | Owner | Wave | Status | Notes / sub-tasks |
|---|---|---|---|---|
| QA batch 1 (harness) | QA/Release Lead | 1 | in_review | MERGED to main (4f10129) 2026-10-11: vitest 3-project setup (unit/integration/integration-stripe), helpers, fake SMTP/webhook catchers, malicious fixture site, smoke tests. 120/120 pass (116 unit + 4 integration), tsc clean — LA-verified run. Gate re-verification pending |
| N-QA-1 | Backend Lead | 1 | pending | CRITICAL (LA reproduced 2026-10-11: signup+login → 401): authPlugin fp-wrap breaks encapsulation → preHandler leaks onto public routes. Fix as first step of P0-01; add public-route integration test |
| N-QA-2 | Backend Lead | 1 | pending | CRITICAL: migrations/003 line 16 `ADD CONSTRAINT IF NOT EXISTS` invalid syntax — whole 003 aborts on fresh DB. Fix the FILE (not yet applied anywhere). Part of P0-02 |
| npm audit | QA/Release Lead | 3 | pending | Blocked by registry policy (`policy_denied`) in this env — CI (Q-02) must cover it |
| test DBs | LA | 0 | verified | Per-worktree DBs created: bseo_test_backend, bseo_test_security, bseo_test_qa (+ shared bseo_test). QA next session MUST use bseo_test_qa |

| ID | Owner | Wave | Status | Notes / sub-tasks |
|---|---|---|---|---|
| N-A1-1 | Backend Lead | 1 | pending | HIGH: Fastify validation errors return HTTP 500, must be 400 VALIDATION_ERROR (frozen contract). Do FIRST — poisons every new route |
| N-A1-2 | Backend Lead | 1 | pending | HIGH: error envelope must match {ok:false, error:{code,message,requestId,details?}} — add requestId |
| N-A1-4 | Security Lead | 1 | pending | Folded into S-06: SameSite strategy for split app/api domains (lax breaks cookie auth) |
| N-A1-7 | Security Lead | 1 | pending | Folded into P0-05: JWT secret ≥32 random chars |
| N-A2-5 | Security Lead | 1 | pending | Folded into S-02: crawler response size cap (gzip-bomb OOM) |
| N-A2-6 | Backend Lead | 1 | pending | Folded into P0-04: require STRIPE_WEBHOOK_SECRET when Stripe keys set (fail fast at boot) |
| JWT-in-body | Security Lead | 1 | pending | Note for S-01/S-05: login returns JWT in JSON body — assess httpOnly-cookie alternative |
| N-A2-1/N-A2-2 | Backend Lead | 2 | pending | HIGHs pre-confirmed as C-03 sub-findings: graceful shutdown + scheduler leader election + isoWeek UTC |
| remaining mediums/lows | various | 2/3 | pending | Routed: robots parser→C-04, metering races→C-02, dup Stripe customers→C-01, webhook idempotency→C-01, Next headers→S-06/FE, README drift→Q-04, /settings/providers+OpenAPI→C-07 |

## Wave 2 — Phase 2 (billing/data/reliability) + Phase 3 (features)

| ID | Owner | Wave | Status | Notes / sub-tasks |
|---|---|---|---|---|
| C-01 | Backend Lead | 2 | pending | Full Stripe event coverage; trials/coupons/annual/proration/dunning/grace |
| C-02 | Backend Lead | 2 | pending | Reserve-then-commit metering; billing-period windows; 80/100% alerts |
| C-03 | Backend Lead | 2 | pending | Fair scheduling, DLQ+replay, graceful shutdown, leader election, circuit breakers |
| C-04 | Backend Lead | 2 | pending | robots crawl-delay, Playwright mode, simhash dupes, sitemap/canonical/hreflang |
| C-05 | Backend Lead | 2 | pending | SERP snapshots, device/location/lang, SERP features, shared cross-tenant cache |
| C-06 | Backend Lead | 2 | pending | Retention+cleanup, EXPLAIN-verified indexes, backups+restore test |
| C-07 | Backend Lead | 2 | pending | Validation everywhere, OpenAPI 3.1 served, idempotency keys, request ids |
| F-01 | Frontend Lead | 2 | pending | Onboarding checklist; sub-task→Backend: progress-state API |
| F-02 | Backend Lead | 2 | pending | Audit v2 engine (impact priority, states, history, PDF/CSV); sub-task→Frontend: UI |
| F-03 | Backend Lead | 2 | pending | Keyword v2 (clustering, gap, cannibalization); sub-task→Frontend: UI |
| F-04 | Backend Lead | 2 | pending | Content v2 (brief→optimize, NLP coverage, WP/Webflow); sub-task→Frontend: UI |
| F-05 | Backend Lead | 2 | pending | GEO v2 (multi-engine, SoV, llms.txt advice); sub-task→Frontend: UI |
| F-06 | Backend Lead | 2 | pending | Backlinks v2 (toxic, anchors, opportunities, disavow); sub-task→Frontend: UI |
| F-07 | Backend Lead | 2 | pending | Competitor analysis; sub-task→Frontend: UI — NOW IN SCOPE |
| F-08 | Backend Lead | 2 | pending | White-label PDF/HTML reports, scheduling; sub-task→Frontend: report UI — NOW IN SCOPE |
| F-09 | Backend Lead | 2 | pending | Agency/team: roles, invites, client workspaces, activity log; sub-task→Frontend: UI — NOW IN SCOPE |
| F-10 | Backend Lead | 2 | pending | Notifications (email/TG/Slack/webhooks, rules, digests); sub-task→Frontend: center UI |
| F-11 | Frontend Lead | 2 | pending | Billing UI (pricing page, meters, invoices, cancel flow); sub-task→Backend: trials/coupons/annual |
| F-12 | Frontend Lead | 2 | pending | Marketing site: landing, docs skeleton, terms/privacy/DPA, cookies, SEO for app |
| F-13 | Backend Lead | 2 | pending | Public API (keys/scopes/webhooks/rate limits); sub-task→Frontend: docs page |
| F-14 | Backend Lead | 2 | pending | Admin back-office endpoints; sub-task→Frontend: UI |

## Wave 3 — Phase 4 (quality/ops) + Phase 5 (world-class)

| ID | Owner | Wave | Status | Notes / sub-tasks |
|---|---|---|---|---|
| Q-01 | QA/Release Lead | 3 | pending | Full pyramid: API integration (real PG/Redis), E2E Playwright, load k6, chaos, security, axe; ≥85% backend core |
| Q-02 | QA/Release Lead | 3 | pending | GitHub Actions CI: lint, tsc strict, tests+services, images, audit, secrets, Trivy, E2E, changelog |
| Q-03 | QA/Release Lead | 3 | pending | pino JSON logs, /metrics, Sentry/OTel hooks, alert examples, status page |
| Q-04 | QA/Release Lead | 3 | pending | README/ARCHITECTURE/runbook/methodology/CONTRIBUTING/SECURITY/CHANGELOG, .env.example |
| Q-05 | QA/Release Lead | 3 | pending | docker-compose.prod.yml (proxy+TLS), healthchecks, backups, zero-downtime notes |
| W-01 | Backend Lead | 3 | pending | Scale: worker split, sharding, cost guardrails; 10k-site load proof |
| W-02 | Backend Lead | 3 | pending | SERP/volume cache w/ provenance; multi-provider fallback; anomaly detection |
| W-03 | Backend Lead | 3 | pending | Model routing, prompt evals w/ golden outputs, per-tenant cost caps |
| W-04 | Backend Lead | 3 | pending | Insights engine (prioritized actions, drop diagnosis, forecast); sub-task→Frontend: UI |
| W-05 | Frontend Lead | 3 | pending | SSE progress, optimistic UI, skeletons, palette, shortcuts, WCAG 2.2 AA, i18n scaffold; sub-task→Backend: SSE endpoints |
| W-06 | Backend Lead | 3 | pending | Plugin interface, webhook catalog, signed delivery + retries + replay |
| W-07 | Backend Lead | 3 | pending | GDPR export/erase, audit log, security.txt, SOC2 checklist; Security Lead reviews |
| W-08 | Backend Lead + Frontend Lead | 3 | pending | p95<200ms hot endpoints, TTI<2s, query budgets, Lighthouse ≥95/90 (split noted) |
| W-09 | QA/Release Lead | 3 | pending | Strict TS (no any new), OpenAPI-generated client, ESLint+Prettier, property tests, seed script, one-command dev |

## Wave 4 — Final audit loop (§9)

| Item | Status |
|---|---|
| Fresh hostile audit pass #1 (A1–A3, new agents) | pending |
| Fixes for pass #1 findings | pending |
| Fresh hostile audit pass #2 | pending |
| Fixes for pass #2 findings (must be zero new medium+) | pending |
| Final regression: wiped DB → full E2E incl. signup→logout→login, Stripe fixtures, load+chaos | pending |

## Exceptions / deferred

(none yet — LA approval required for any)

## Handoff log (LA → parent)

- Wave 0 gate: (to be sent)
