# ARCHITECTURE_PLAN.md — Beyonix SEO Tool Program Control (Lead Architect owned)

This is the LA-owned master plan for the master-prompt program ("strong MVP → world-class sellable SEO+GEO SaaS").
Source spec: `~/workspace/user/files/SEO_TOOL_MASTER_PROMPT_1_yhjl.md`.
Status board: `PROGRESS.md`. Findings: `AUDIT_RESULT.md`. Prior product architecture: `ARCHITECTURE.md`. Build contracts: `CONTRACTS.md`.

## 0. Scope decision (LA, 2026-10-11)

The master prompt **SUPERSEDES earlier v2-deferrals where they conflict**. The following are IN SCOPE for this program:
white-label reports (F-08), agency/team workspaces (F-09), competitor analysis (F-07), PDF reports.
Recorded in PROGRESS.md. No agent may defer these as "v2" without LA approval.

## 1. Runtime layout

```
beyonix-seo-tool/
├── backend/            # Fastify + TypeScript API, BullMQ workers, node-cron scheduler
│   ├── src/
│   │   ├── routes/     # auth, billing, sites, audit, keywords, ranks, content, onpage,
│   │   │               # backlinks, geo, reports, settings, gsc, ga4 (+ new: account, admin, apikeys, webhooks, competitors)
│   │   ├── middleware/ # auth (tenant scoping), rate limiting, errors, request-id
│   │   ├── providers/  # stripe, google, dataforseo, llm, notify (+types.ts = frozen interface)
│   │   ├── services/   # crawler, auditRules, keyword/rank/backlink/content/geo/report logic
│   │   ├── prompts/    # versioned LLM prompt templates
│   │   ├── db/         # migrations/ (005_*.sql and up; NEVER edit applied migrations)
│   │   ├── queues.ts / worker.ts / scheduler.ts
│   │   ├── config.ts / db.ts / crypto.ts / metering.ts / plans.ts / errors.ts
│   │   └── index.ts    # buildApp() — route registration (regression-tested by p7)
│   └── tests/          # vitest suites (integration-first from Wave 1; see QA plan)
├── frontend/           # Next.js 14 (App Router) — marketing site + app dashboard
│   ├── app/            # (marketing)/, login, signup, dashboard/, admin/
│   ├── components/     # design system (Beyonix dark), tabs/, charts
│   └── lib/api.ts      # typed API client (to be GENERATED from OpenAPI in W-09)
├── docker-compose.yml / docker-compose.prod.yml (Wave 3: Q-05)
├── .github/workflows/ (Wave 3: Q-02)
└── docs: ARCHITECTURE.md, CONTRACTS.md, README.md, runbook (Q-04), RELEASE_NOTES.md (final)
```

## 2. Team (adapted to platform limits)

Platform allows LA → role agents only (no third level). Five steady role agents do their module work
themselves, sequentially. Cross-role review provides the "second agent" rule (§8.3).

| Role agent | Owns (IDs) | Modules |
|---|---|---|
| Audit Lead | (no fix IDs) baseline + regression + final hostile audits → AUDIT_RESULT.md | read-only, whole repo |
| Security Lead | P0-05, S-01..S-10; reviews all security-sensitive changes | auth hardening, crypto, SSRF, OAuth, headers, containers |
| Backend Lead | P0-01, P0-02, P0-04, C-01..C-07, backend parts of F-01..F-14, W-01..W-04, W-06..W-09(be) | routes, services, providers, queues, db/migrations, workers |
| Frontend Lead | P0-03, frontend parts of F-01..F-14, W-05(fe), W-08(fe) | app/, components/, lib/, marketing, a11y |
| QA/Release Lead | Q-01..Q-05; test-writing support for all waves; owns phase-gate test runs | tests/, CI, E2E, load/chaos, docs accuracy |

F-*/W-* items spanning backend+frontend have ONE primary owner (table in PROGRESS.md); the other role
contributes via a written sub-task request recorded in PROGRESS.md notes (never silent cross-edits).

## 3. Frozen contracts (before any parallel work)

1. **DB migrations:** new files only, `backend/migrations/005_*.sql`, `006_*`, … (the actual migrations dir; NOT `src/db/`) — never edit an
   applied migration. Number ranges reserved: Security Lead `005–009`, Backend Lead `010–039`,
   QA Lead none (fixtures via seed script). LA resolves collisions.
2. **Provider interfaces:** `backend/src/providers/types.ts` is frozen; new providers implement it.
   Mock-vs-real boundary: every provider MUST work with empty credentials (deterministic mock) and MUST
   report which mode it is in (`/api/v1/settings/providers` + README table).
3. **API error envelope:** `{ ok:false, error:{ code, message, requestId, details? } }` on all routes;
   validation errors → `VALIDATION_ERROR` (400); auth → 401; tenant/role → 403/404 (no existence leak);
   plan limits → 402 with `{ upgrade, limit, used }`.
4. **Shared types:** backend `src/types.ts` is the source of truth; frontend `lib/api.ts` mirrors it
   until W-09 generates the client from OpenAPI.
5. **OpenAPI 3.1:** served at `/api/v1/openapi.json` + docs page (C-07); regenerated on route changes.
6. **Tenancy rule:** every tenant-owned query carries `tenant_id` (or `site.tenant_id` join); enforced in
   middleware + reviewed in every PR touching data access.
7. **PROGRESS.md/AUDIT_RESULT.md:** LA owns PROGRESS.md edits (agents report; LA writes). Audit Lead owns
   AUDIT_RESULT.md. No one else edits these files.

## 4. Environment (honesty record)

- **No Docker daemon on this VM** (verified 2026-10-11). All verification runs NATIVELY.
- Postgres 16.15 (system cluster, online) — databases `bseo` (dev) and `bseo_test` (tests), role `bseo`.
- Redis 7.0.15 (system, PONG verified).
- Node v24.20.0, npm 10.9.4. Backend `node_modules` present; tests run via `vitest run`.
- `DATABASE_URL=<redacted>`, `REDIS_URL=redis://localhost:6379` for local runs.
- Dockerfiles/compose files are still maintained for production deploys (Q-05, S-10) but are
  verified by file review + CI (GitHub Actions) rather than local `docker compose up`.
- Git: repo initialized at Wave 0 (`main` = audited MVP baseline). Branch naming `agent/<role>/<id>`;
  only LA merges to `main` after gate checks.

## 5. Wave plan & gates

- **Wave 0** (LA + Audit Lead, serial): repo read, infra up, baseline recorded, contracts frozen,
  PROGRESS.md/AUDIT_RESULT.md created. Gate: docs exist, baseline green, audit brief issued.
- **Wave 1**: P0-01..P0-05 + S-01..S-10 (Security, Backend, Frontend, QA support). Gate: P0/S items
  verified with tests + review; full suite green; tsc strict clean.
- **Wave 2**: C-01..C-07 + F-01..F-14 (Backend + Frontend + QA). Gate: billing/data/reliability proven
  (incl. chaos: kill Redis/PG/worker mid-job), features demoable, E2E journey green.
- **Wave 3**: Q-01..Q-05 + W-01..W-09 (QA + Backend + Frontend). Gate: coverage ≥85% backend core,
  load/chaos pass, CI green, docs match code, prod compose deployable from wiped machine (file-verified).
- **Wave 4**: final hostile audit loop (§9) with FRESH auditors → fixes → repeat until two consecutive
  clean passes (no new medium+). Then Final Gate (§10).

Phase-gate rule: no wave starts until the previous gate passes. LA sends the parent a ≤15-line handoff
per gate.

## 6. Review & verification rules

- Test-first per §8.2. No item `verified` without a passing test AND a different agent's review.
- Security-sensitive changes (auth, billing, SSRF, crypto, tenant scoping) → Security Lead must review.
- QA Lead re-runs engineer test suites; LA spot-checks; Auditors independently re-verify.
- Honesty: never claim unrun work. Every handoff states what ran where (native PG/Redis here).
