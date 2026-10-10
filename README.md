# Beyonix SEO Tool — MVP

Self-serve SEO + GEO SaaS for small businesses. Customer signs up → connects
website → gets technical audits, keyword research, rank tracking, AI-written
SEO+GEO content, backlink monitoring, AI-visibility (GEO) tracking, and
plain-language weekly reports. Monthly subscription via Stripe.

Full product/architecture decisions: [ARCHITECTURE.md](ARCHITECTURE.md).
Build contracts (DB schema, API map, provider interfaces): [CONTRACTS.md](CONTRACTS.md).

## Quick start (Docker)

```bash
cp .env.example .env
# edit .env — at minimum set JWT_SECRET (everything else can stay empty = mock mode)
docker compose up --build
```

- App: http://localhost:3000
- API: http://localhost:4000 (`GET /healthz`)
- The `api` container runs DB migrations on boot. `worker` runs BullMQ
  processors + the cron scheduler.

## Local dev (no Docker)

Needs Postgres 16 + Redis 7 running locally.

```bash
# backend
cd backend && npm install
# set DATABASE_URL=postgres://... REDIS_URL=redis://... in .env
npm run dev          # API on :4000
npm run dev:worker   # workers + scheduler

# frontend (another terminal)
cd frontend && npm install
# NEXT_PUBLIC_API_URL=http://localhost:4000
npm run dev          # on :3000
```

## Environment variables

See [.env.example](.env.example) — every variable is documented there.
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

- **Real, no keys needed:** auth/JWT, multi-tenancy, plans + metering + 402
  limits, site verification (meta/file/DNS), the audit **crawler + 16-rule
  engine + health score** (cheerio, robots.txt respected), GEO formatting of
  content, HTML/Markdown export with FAQ schema, BullMQ jobs (retry/backoff,
  idempotent, per-tenant rate limits), weekly report generation, Stripe
  **flow** (checkout → webhook → subscription row → plan upgrade).
- **Mock until keys are added:** Stripe (in-memory-feeling mock with a local
  confirm URL — full subscribe flow testable), Google/GSC/GA4 (sample
  queries + backlinks + GA4 properties/traffic), DataForSEO (deterministic
  plausible volume/difficulty/SERP), LLM (structured template drafts —
  clearly labeled), email/Telegram (logged to console).
- **Simulated by design:** GEO "AI citation" checks use our LLM to simulate a
  platform answer, then detect brand mentions. Honest and labeled; swap in
  native platform APIs later.

## Architecture

```
Next.js (web) → Fastify API (api) → Postgres
                    ↓
              Redis + BullMQ → workers (crawl, rank-check, keyword-refresh,
                                         geo-check, report, content)
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
cd backend && npm test        # vitest, 108 tests, no DB/redis needed
cd backend && npx tsc --noEmit
cd frontend && npm run build  # must be clean
```

Suites cover: tenant scoping (every query asserted to carry `tenant_id`),
metering/limits (402 paths), crawler rules (HTML fixtures), billing webhook
event application, job idempotency helpers, provider mock fallbacks,
prompt rendering, GEO HTML export.

## Production checklist (keys the owner must provide)

1. `JWT_SECRET`, `ENCRYPTION_KEY` (generate, never commit)
2. Stripe: secret key, webhook secret, 3 price IDs; set webhook URL to
   `/api/v1/billing/webhook`
3. Google Cloud: OAuth client (Search Console + Analytics readonly scopes);
   set `GOOGLE_REDIRECT_URI`
4. DataForSEO login/password (pay-as-you-go; caching keeps it cheap)
5. `GEMINI_API_KEY` (cheap default) or `OPENAI_API_KEY`
6. `SMTP_*` and/or `TELEGRAM_BOT_TOKEN` for notifications

## Deferred to v2 (explicitly out of MVP scope)

- CMS direct publish (WordPress/Webflow) — v1 exports copy-paste HTML/Markdown
- White-label reports, agency multi-client workspaces
- DataForSEO backlinks API (v1 uses GSC links)
- Native ChatGPT/Perplexity/Gemini citation APIs (v1 simulates via LLM)
