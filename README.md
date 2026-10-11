# Beyonix SEO Tool

Self-serve SEO + GEO SaaS for small businesses (and agencies). Customer signs
up → connects website → gets technical audits, keyword research, rank
tracking, AI-written SEO+GEO content, backlink monitoring, AI-visibility
(GEO) tracking, competitor analysis, team workspaces, and plain-language
weekly reports. Monthly/annual subscription via Stripe (real or mock mode).

![CI](https://github.com/beyonix/beyonix-seo-tool/actions/workflows/ci.yml/badge.svg)

Docs: [ARCHITECTURE.md](ARCHITECTURE.md) · [CONTRACTS.md](CONTRACTS.md) ·
[RUNBOOK.md](RUNBOOK.md) · [docs/methodology.md](docs/methodology.md) ·
[docs/observability.md](docs/observability.md) · [CHANGELOG.md](CHANGELOG.md)

## Quick start (one command, local dev)

Needs Postgres 16 + Redis 7 running locally.

```bash
make dev        # installs, migrates, seeds demo data, starts API+worker+web
```

- App: http://localhost:3000
- API: http://localhost:4000 (`GET /healthz`, `GET /readyz`, `GET /status`, `GET /metrics`)
- Demo login after seeding: **demo@beyonix.local / DemoPass123!** (local demo only)

## Quick start (Docker)

```bash
cp .env.example .env
# edit .env — at minimum set JWT_SECRET (everything else can stay empty = mock mode)
docker compose up --build
```

For production: `docker compose -f docker-compose.prod.yml up --build`
(reverse proxy + automatic TLS, healthchecks, resource limits, backup
sidecar — see [RUNBOOK.md](RUNBOOK.md)). **Docker was not available in the
build environment, so the compose files are statically validated (YAML) but
have never been booted.**

## Environment variables

See [.env.example](.env.example) — every variable is documented there, and
completeness was proven by grepping every `opt()`/`req()` call in
`backend/src/config.ts` plus all live `process.env` reads in
services/providers/routes (Wave 3 audit, 2026-10-11).

The rule: **anything left empty runs in mock mode** (deterministic,
offline-testable). Mock mode is the default and the whole app works in it.

| Key | Real behavior when set |
|---|---|
| `STRIPE_SECRET_KEY` (+ webhook secret, price IDs) | Real checkout, portal, webhooks |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Real OAuth, real Search Console queries |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | Real keyword volume/difficulty + SERP positions |
| `GEMINI_API_KEY` or `OPENAI_API_KEY` | Real AI drafts/summaries (default: Gemini Flash) |
| `SMTP_*` | Real notification emails |
| `TELEGRAM_BOT_TOKEN` | Real Telegram alerts |
| `ENCRYPTION_KEY` | AES-256-GCM for stored OAuth/API keys (32-byte hex) |

## What's mock vs real (honest list)

- **Real, no keys needed:** auth/JWT (+TOTP 2FA), multi-tenancy + team roles,
  plans + metering + 402 limits, site verification (meta/file/DNS),
  the audit **crawler + rule engine + health score** (cheerio, robots.txt
  respected), GEO formatting of content, HTML/Markdown/DOCX/PDF export,
  BullMQ jobs (retry/backoff, idempotent, per-tenant rate limits, dead-letter
  queue), weekly report generation, Stripe **flow** (checkout → webhook →
  subscription row → plan upgrade), public API + webhooks, admin back-office.
- **Mock until keys are added:** Stripe (in-memory-feeling mock with a local
  confirm URL — full subscribe flow testable; **disabled in production**),
  Google/GSC/GA4 (sample queries + backlinks + traffic), DataForSEO
  (deterministic seeded volume/difficulty/SERP, labeled `dataSource: 'mock'`),
  LLM (structured template drafts — clearly labeled), email/Telegram (logged
  to console).
- **Simulated by design:** GEO "AI citation" checks use our LLM to simulate a
  platform answer, then detect brand mentions. Honest and labeled
  (`simulated: true`); swap in native platform APIs later.

## Architecture

```
Next.js (web) → Fastify API (api) → Postgres
                    ↓
              Redis + BullMQ → workers (crawl, rank-check, keyword-refresh,
                                         geo-check, report, content, backlink-refresh, reverify)
                    ↓
Providers (all interfaced, all with mock fallback):
  LLM (Gemini/OpenAI/mock) · DataForSEO (cached 30d/7d, metered on miss) ·
  Stripe (real/mock) · Google OAuth/GSC/GA4 (real/mock) · Notify (SMTP/Telegram/log)
```

Key files: `backend/src/index.ts`, `backend/src/worker.ts`,
`backend/src/scheduler.ts`, `backend/src/routes/*`, `backend/src/services/*`,
`backend/src/providers/*`, `backend/migrations/001_init.sql`.

**Plans** (`backend/src/plans.ts`): starter (1 site, 50 keywords, 5k AI
words/mo), growth (3/300/30k), pro (10/1000/100k). Limits enforced with
HTTP 402 + upgrade prompt.

## Tests

```bash
cd backend && npm test              # all 3 vitest projects: unit, integration, integration-stripe
cd backend && npm run test:coverage # core modules (services/routes/metering/plans/config)
cd backend && npx tsc --noEmit
cd frontend && npm run build         # must be clean
```

Suites (Wave 3, ~600 tests): tenant scoping on every resource,
metering/limits (402 paths), crawler rules + malicious fixtures, signed
Stripe webhook fixtures (real SDK verification), worker crash/retry/
idempotency, API journey E2E (signup→crawl→billing→logout→login), chaos
(kill-mid-job), security (IDOR/SSRF/XSS/CSRF/rate-limit), observability.

On this VM, tests need the QA test database first:
`source ~/workspace/.local/qa-env.sh`.

## Production checklist (keys the owner must provide)

1. `JWT_SECRET`, `ENCRYPTION_KEY` (generate, never commit)
2. Stripe: secret key, webhook secret, 3 price IDs; set webhook URL to
   `/api/v1/billing/webhook`. Plan changes resolve from the Stripe price id
   via `STRIPE_PRICE_*` (single source of truth), falling back to the
   subscription metadata `planId`.
3. Google Cloud: OAuth client (Search Console + Analytics readonly scopes);
   set `GOOGLE_REDIRECT_URI`
4. DataForSEO login/password (pay-as-you-go; caching keeps it cheap)
5. `GEMINI_API_KEY` (cheap default) or `OPENAI_API_KEY`
6. `SMTP_*` and/or `TELEGRAM_BOT_TOKEN` for notifications
7. `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `SENTRY_DSN` (optional),
   `APP_HOST`/`API_HOST` + `APP_TLS_EMAIL` for the prod proxy

## What changed vs the old MVP README

The old README described the MVP only ("Deferred to v2" listed white-label,
agency workspaces, competitor analysis, PDF reports, CMS publish — all of
which are now implemented per the master prompt program). This README
reflects the Wave-3 codebase.
