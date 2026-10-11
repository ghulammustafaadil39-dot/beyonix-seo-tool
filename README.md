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
# edit .env — compose REQUIRES POSTGRES_PASSWORD and REDIS_PASSWORD
# (fails fast on the :? guards without them). JWT_SECRET is optional for
# local dev (dev default is used); everything else can stay empty = mock mode.
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

The rule holds everywhere: **anything left empty runs in mock mode.**

**Real, no keys needed:** auth/JWT (+TOTP 2FA), multi-tenancy + team roles,
plans + metering + 402 limits, site verification (meta/file/DNS),
the audit **crawler + rule engine + health score** (real HTTP via safeFetch,
robots.txt respected — no JS execution; Playwright mode deferred),
HTML/Markdown/DOCX/PDF export, BullMQ jobs (retry/backoff, idempotent,
per-tenant rate limits, dead-letter queue), weekly report generation,
Stripe **flow** (checkout → webhook → subscription row → plan upgrade),
outbound signed webhooks, public API, admin back-office.

| Integration | Real when… | Mock/fallback behavior | Env config | Code |
|---|---|---|---|---|
| **Stripe billing** | `STRIPE_SECRET_KEY` (+ webhook secret, `STRIPE_PRICE_*`) → real checkout, portal, webhook verification | Dev/test: mock provider with local mock-confirm URL; mock webhooks signed with `MOCK_WEBHOOK_SECRET`. **Production without keys → 503 `BILLING_NOT_CONFIGURED` (fail-closed).** | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` (+ `_ANNUAL`) | `backend/src/providers/stripe.ts` |
| **DataForSEO** | `DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD` → real volume, organic difficulty, SERP, competitor keywords; cached **30d (metrics) / 7d (SERP)** | Deterministic seeded mock, responses labeled `dataSource: 'mock'` | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | `backend/src/providers/dataforseo.ts`, `backend/src/services/keywordCache.ts` |
| **LLM** | `GEMINI_API_KEY` → real Gemini; `OPENAI_API_KEY` → real OpenAI; tenant BYOK honored (`llm_provider` + encrypted `llm_api_key_enc`) | Structured template drafts (labeled). **Fail-closed: a BYOK key with no explicit provider is never sent anywhere.** | `GEMINI_API_KEY`/`OPENAI_API_KEY`, `LLM_PROVIDER` | `backend/src/providers/llm.ts` |
| **Google OAuth/GSC/GA4** | `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` → real OAuth (PKCE), real GSC queries/backlinks, GA4 data | Sample data — **only in test/development** (`isMockGoogleAllowed()` fails closed in production) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | `backend/src/providers/google.ts` |
| **Email (SMTP)** | `SMTP_HOST` etc. → real delivery | Logged to console | `SMTP_*` | `backend/src/providers/notify.ts` |
| **Telegram** | `TELEGRAM_BOT_TOKEN` → real `sendMessage` | Logged to console | `TELEGRAM_BOT_TOKEN` | `backend/src/providers/notify.ts` |
| **Slack** | Tenant webhook URL in notification settings → real POST via safeFetch | "not configured" error | notification settings (per tenant) | `backend/src/services/notifications.ts` |
| **Outbound webhooks** | Real: HMAC-signed (`X-BSEO-Signature`) POSTs, retries + replay | — | tenant webhook subscriptions | `backend/src/services/webhookDelivery.ts` |
| **CMS publish** | `CMS_PUBLISH_ENABLED=true` + credentials → real WordPress/Webflow | `{ ok: true, mock: true }`, **zero network calls** | `CMS_PUBLISH_ENABLED`, `CMS_WP_*`, `CMS_WEBFLOW_*` | `backend/src/services/publishConnector.ts` |
| **GEO / AI visibility** | — | **Simulated by design:** our LLM generates a platform-style answer, then we detect brand mentions; every row labeled `simulated: true` | follows LLM config | `backend/src/services/geoService.ts` |
| **CAPTCHA** | `CAPTCHA_PROVIDER=hcaptcha` + secret → real hCaptcha, fail-closed | `none` default; `test` provider **refused in production** | `CAPTCHA_PROVIDER`, `CAPTCHA_SECRET` | `backend/src/providers/captcha.ts` |
| **PageSpeed** | Real Google PageSpeed API v5 (free), cached 7d, quota-guarded | — | — | `backend/src/services/pagespeed.ts` |
| **Backlinks** | Real via GSC when Google is configured | GSC samples otherwise; DataForSEO backlinks API **not wired** | follows Google config | `backend/src/services/backlinkJobs.ts` |

### Access control & security (verified in code)

- **Team roles on mutations:** mutating routes are role/scoped. `PATCH
  /settings` requires `owner`/`admin` (whole-route gate — a viewer cannot
  change the LLM cost cap or overwrite a BYOK key)
  (`backend/src/routes/settings.ts`). Tenant users carry scopes checked by
  `requireScope`/`requireRole` (`backend/src/middleware/access.ts`).
- **BYOK fail-closed:** a tenant API key stored without an explicit
  `llm_provider` is never routed to a guessed provider — the request throws
  instead (`backend/src/providers/llm.ts`, A2-H1).
- **Impersonation (admin):** `POST /api/v1/admin/impersonate` returns a
  5-minute owner-token as JSON; the Next.js same-origin route
  `/api/admin/impersonate` forwards the admin's session cookies + CSRF to the
  API and returns the token to the browser **only as an httpOnly
  Set-Cookie** — no token in JS, URL, or response body. Every impersonation
  is audit-logged and registered as a revocable session
  (`backend/src/routes/admin.ts`,
  `frontend/app/api/admin/impersonate/route.ts`).
- **Billing portal scope:** `POST /billing/portal` requires `owner`/`admin`
  or the `billing:write` scope — a read-only user cannot mint a portal
  session (`backend/src/routes/billing.ts`, B1-M2).

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
