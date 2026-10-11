# Beyonix SEO Tool — Build Contracts (v1)

Single source of truth for all module builders. Follow EXACTLY. Do not invent
parallel conventions.

Repo root: `~/workspace/beyonix-seo-tool/`

```
beyonix-seo-tool/
  ARCHITECTURE.md
  CONTRACTS.md            (this file)
  .env.example
  docker-compose.yml
  README.md
  backend/
    package.json  tsconfig.json  Dockerfile  vitest.config.ts
    migrations/001_init.sql
    src/
      index.ts            (Fastify app; registers all routes, listens)
      worker.ts           (BullMQ processors; run via `node dist/worker.js`)
      config.ts           (env parsing, single place)
      db.ts               (pg Pool + query helpers)
      errors.ts           (ApiError, error envelope)
      plans.ts            (PLANS, LIMITS, plan helpers)
      metering.ts         (recordUsage, getUsage, checkLimit)
      crypto.ts           (encrypt/decrypt for stored OAuth/API keys)
      middleware/auth.ts  (auth plugin: sets req.tenant; use on ALL tenant routes)
      providers/
        types.ts          (LLMProvider, KeywordSerpProvider, PaymentsProvider,
                           GoogleProvider, NotifyProvider interfaces + factories)
        llm.ts            (Gemini/OpenAI real + MockLLM)
        dataforseo.ts     (DataForSEO REST real + MockDataForSEO)
        stripe.ts         (Stripe SDK real + MockStripe)
        google.ts         (Google OAuth + GSC/GA4 real + MockGoogle)
        notify.ts         (SMTP email + Telegram real + mock-log)
      queues.ts           (queue objects + enqueue helpers + job name constants)
      routes/             (one file per domain; each exports `registerX(fastify)`)
      services/           (business logic; NO fastify imports here)
      prompts/            (*.txt versioned prompt templates)
    tests/                (vitest; `npm test` — must run WITHOUT postgres/redis)
  frontend/
    (Next.js App Router; see section 9)
```

---

## 1. Environment variables (also in `.env.example`)

```
# core
NODE_ENV=development|production|test
PORT=4000
DATABASE_URL=postgres://bseo:bseo@postgres:5432/bseo
REDIS_URL=redis://redis:6379
JWT_SECRET=<random 32+ chars>
APP_URL=http://localhost:3000
API_URL=http://localhost:4000
ENCRYPTION_KEY=<32-byte hex for stored OAuth/API keys>

# Stripe (leave empty => MockStripe)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_STARTER=   # price_... per plan
STRIPE_PRICE_GROWTH=
STRIPE_PRICE_PRO=

# Google OAuth / GSC (leave empty => MockGoogle)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:4000/api/v1/sites/gsc/callback

# DataForSEO (leave empty => MockDataForSEO)
DATAFORSEO_LOGIN=
DATAFORSEO_PASSWORD=

# LLM (first available wins; none => MockLLM)
LLM_PROVIDER=gemini|openai   # optional override
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.0-flash
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini

# Notifications (leave empty => logged mock)
SMTP_HOST= SMTP_PORT=587 SMTP_USER= SMTP_PASS= SMTP_FROM=
TELEGRAM_BOT_TOKEN= TELEGRAM_CHAT_ID=
```

Rule: **every provider factory must work with empty keys** (mock mode). Log
`[provider] using MOCK <name> (no key configured)` once at startup.

---

## 2. Database

Postgres 16. Migrations in `backend/migrations/*.sql`, run in order at API
startup (simple runner in `db.ts`: `migrations` table).
`001_init.sql` base schema; `002_additions.sql` keyword `group_key`;
`003_additions.sql` site location columns, location-aware metrics cache PK,
reports unique constraint, `users.token_version`; `004_ga4.sql`
`sites.ga4_property_id`.

### Tables (all tenant-owned tables carry `tenant_id UUID NOT NULL`)

```sql
tenants(id UUID PK, name TEXT, plan_id TEXT DEFAULT 'starter',
        stripe_customer_id TEXT, llm_provider TEXT, llm_api_key_enc TEXT,
        notify_email TEXT, telegram_chat_id TEXT, created_at TIMESTAMPTZ DEFAULT now());

users(id UUID PK, tenant_id UUID NOT NULL REFERENCES tenants(id),
      email CITEXT UNIQUE NOT NULL, password_hash TEXT, name TEXT,
      role TEXT DEFAULT 'owner', google_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now());

sites(id UUID PK, tenant_id UUID NOT NULL REFERENCES tenants(id),
      domain TEXT NOT NULL, verified BOOLEAN DEFAULT FALSE,
      verify_token TEXT, gsc_connected BOOLEAN DEFAULT FALSE,
      gsc_refresh_token_enc TEXT, ga4_connected BOOLEAN DEFAULT FALSE,
      ga4_property_id TEXT,                       -- migration 004
      serp_location_code INT DEFAULT 2840,       -- migration 003
      serp_location_name TEXT DEFAULT 'United States',
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(tenant_id, domain));
-- NOTE: verify_token and gsc_refresh_token_enc are NEVER returned by the API;
-- toPublicSite() strips them (the verify token is shown only once, in the
-- POST /sites/:id/verify response).

audits(id UUID PK, tenant_id UUID NOT NULL, site_id UUID NOT NULL REFERENCES sites(id),
       status TEXT DEFAULT 'queued', -- queued|running|done|failed
       started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
       score INT, issues_count INT DEFAULT 0, pages_crawled INT DEFAULT 0,
       error TEXT);

audit_issues(id UUID PK, tenant_id UUID NOT NULL, audit_id UUID NOT NULL REFERENCES audits(id),
       site_id UUID NOT NULL REFERENCES sites(id),
       type TEXT NOT NULL, severity TEXT NOT NULL, -- info|warning|error
       url TEXT NOT NULL, detail TEXT NOT NULL, fix_suggestion TEXT NOT NULL,
       status TEXT DEFAULT 'open'); -- open|fixed|ignored

keywords(id UUID PK, tenant_id UUID NOT NULL, site_id UUID NOT NULL REFERENCES sites(id),
       keyword TEXT NOT NULL, volume INT, difficulty INT, intent TEXT,
       priority_score DOUBLE PRECISION, added_from TEXT, tracked BOOLEAN DEFAULT FALSE,
       created_at TIMESTAMPTZ DEFAULT now(),
       UNIQUE(site_id, keyword));

rank_checks(id UUID PK, tenant_id UUID NOT NULL, keyword_id UUID NOT NULL REFERENCES keywords(id),
       checked_at TIMESTAMPTZ DEFAULT now(), position INT, url TEXT,
       serp_features JSONB);

content_pieces(id UUID PK, tenant_id UUID NOT NULL, site_id UUID NOT NULL REFERENCES sites(id),
       keyword_id UUID REFERENCES keywords(id), title TEXT NOT NULL,
       outline TEXT, draft TEXT, status TEXT DEFAULT 'draft', -- draft|review|approved
       ai_words_used INT DEFAULT 0,
       created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());

geo_checks(id UUID PK, tenant_id UUID NOT NULL, site_id UUID NOT NULL REFERENCES sites(id),
       query TEXT NOT NULL, platform TEXT NOT NULL, mentioned BOOLEAN,
       context_snippet TEXT, checked_at TIMESTAMPTZ DEFAULT now());

backlinks(id UUID PK, tenant_id UUID NOT NULL, site_id UUID NOT NULL REFERENCES sites(id),
       source_url TEXT NOT NULL, target_url TEXT NOT NULL,
       first_seen DATE DEFAULT CURRENT_DATE, last_seen DATE DEFAULT CURRENT_DATE,
       status TEXT DEFAULT 'active', -- active|lost
       UNIQUE(site_id, source_url, target_url));

usage_events(id UUID PK, tenant_id UUID NOT NULL, site_id UUID REFERENCES sites(id),
       event_type TEXT NOT NULL, -- ai_words|serp_check|keyword_metric|geo_check|crawl_page
       units INT NOT NULL DEFAULT 1, meta JSONB,
       created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX ON usage_events(tenant_id, event_type, created_at);

subscriptions(id UUID PK, tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id),
       stripe_sub_id TEXT, stripe_customer_id TEXT, plan_id TEXT NOT NULL,
       status TEXT NOT NULL, -- active|past_due|canceled|trialing|mock
       current_period_end TIMESTAMPTZ);

reports(id UUID PK, tenant_id UUID NOT NULL, site_id UUID NOT NULL REFERENCES sites(id),
       period_start DATE NOT NULL, period_end DATE NOT NULL,
       summary TEXT NOT NULL, highlights JSONB,
       created_at TIMESTAMPTZ DEFAULT now());

-- global caches (NOT tenant-scoped; keyed by query text only)
keyword_metrics_cache(keyword TEXT PRIMARY KEY, volume INT, difficulty INT,
       fetched_at TIMESTAMPTZ DEFAULT now());
serp_cache(cache_key TEXT PRIMARY KEY, position INT, url TEXT,
       serp_features JSONB, fetched_at TIMESTAMPTZ DEFAULT now());
```

Conventions: `id` = `gen_random_uuid()` default. `CITEXT` — enable `citext`
extension in migration 001. Timestamps TIMESTAMPTZ.

---

## 3. Plans & metering (`backend/src/plans.ts`, `metering.ts`)

```ts
export const PLANS = {
  starter: { max_sites: 1,  max_keywords_tracked: 50,   ai_words_month: 5_000,
             crawl_pages: 100,  rankcheck_freq: 'weekly', geo_checks_month: 20 },
  growth:  { max_sites: 3,  max_keywords_tracked: 300,  ai_words_month: 30_000,
             crawl_pages: 500,  rankcheck_freq: 'weekly', geo_checks_month: 100 },
  pro:     { max_sites: 10, max_keywords_tracked: 1000, ai_words_month: 100_000,
             crawl_pages: 2000, rankcheck_freq: 'daily',  geo_checks_month: 500 },
} as const;
export type PlanId = keyof typeof PLANS;
```

`metering.ts`:
- `recordUsage(tenantId, eventType, units, siteId?, meta?)` → inserts usage_events row.
- `getUsage(tenantId, eventType)` → SUM(units) since start of current calendar month (UTC).
- `checkLimit(tenant, kind)` → `{ ok: boolean; used: number; limit: number }`
  kinds: `'sites' | 'keywords_tracked' | 'ai_words' | 'geo_checks'`.
  `sites` counts rows in sites; `keywords_tracked` counts keywords WHERE tracked.
- On `!ok`, routes return **402** `{ error: { code: 'LIMIT_EXCEEDED', message, used, limit, upgrade: true } }`.

---

## 4. Auth & tenant middleware (`middleware/auth.ts`)

- `POST /api/v1/auth/signup {email,password,name}` → creates tenant + owner user,
  returns `{ user, tenant }` (session JWT is set ONLY via the httpOnly `bseo_token`
  cookie — never in the JSON body). 409 if email exists.
- `POST /api/v1/auth/login {email,password}` → `{ user, tenant }` (cookie-only
  session token). 401 bad creds. With 2FA enabled: `{ totpRequired: true, totpToken }`
  (short-lived challenge token — the only body token, required by the 2FA UI step).
- Passwords: bcrypt (12 rounds). JWT: HS256, 7d expiry, payload `{ uid, tid }`.
- Token transport: `Authorization: Bearer <t>` OR httpOnly cookie `bseo_token`.
- `authPlugin` (fastify plugin): verifies token, loads user+tenant(+plan),
  sets `req.tenant = { userId, tenantId, plan: PlanId, email }`. 401 otherwise.
- **Every tenant route uses `authPlugin`.** Services receive `tenantId`
  explicitly; raw SQL always includes `AND tenant_id = $n`.
- Google OAuth: `GET /api/v1/auth/google` → redirect; callback creates/links user.

---

## 5. API conventions

- Base path `/api/v1`. Health: `GET /healthz` (no auth).
- Success: JSON object. Lists: `{ data: [...], page, limit, total }`.
- Errors: status + `{ error: { code: string, message: string, ...extra } }`.
- Validation: fastify schema on every route (no unvalidated bodies).

### Route map (each file exports `registerX(fastify)`)

| File | Routes |
|---|---|
| `routes/auth.ts` | signup, login, logout, me, google, google/callback |
| `routes/billing.ts` | `POST /billing/checkout {planId}` → `{url}`; `GET /billing/subscription`; `POST /billing/portal` → `{url}`; `POST /billing/webhook` (raw body, no auth) |
| `routes/sites.ts` | `GET /sites`, `POST /sites {domain}` (limit: sites), `GET /sites/:id`, `PATCH /sites/:id`, `DELETE /sites/:id`, `POST /sites/:id/verify {method:'meta'\|'file'\|'dns'}` → `{token,instructions,verified}`, `GET /sites/:id/overview` (score, counts, latest) |
| `routes/gsc.ts` | `GET /sites/:id/gsc/auth-url`, `GET /gsc/callback?code&state`, `GET /sites/:id/gsc/queries` (cached sample or real) |
| `routes/ga4.ts` | `GET /sites/:id/ga4/auth-url`, `GET /ga4/callback?code&state`, `GET /sites/:id/ga4/properties` (GA4 properties of the connected Google account), `POST /sites/:id/ga4/connect {property_id}` (id validated against the account list), `GET /sites/:id/ga4/overview` (28d sessions/users/pageviews/top pages/top referrers), `POST /sites/:id/ga4/disconnect`. Shares the GSC Google OAuth token (analytics.readonly already in scope). |
| `routes/audit.ts` | `POST /sites/:id/audits` (enqueues crawl; 409 if one queued/running), `GET /sites/:id/audits`, `GET /audits/:auditId`, `GET /audits/:auditId/issues?severity&status`, `PATCH /issues/:issueId {status}` |
| `routes/keywords.ts` | `POST /sites/:id/keywords/research {seeds:[], limit?}` (limit: none, but meters keyword_metric), `GET /sites/:id/keywords?tracked`, `DELETE /keywords/:kwId`, `POST /keywords/:kwId/track` (limit: keywords_tracked), `POST /keywords/:kwId/untrack` |
| `routes/ranks.ts` | `GET /sites/:id/ranks` (latest position per tracked keyword + 30d spark), `GET /keywords/:kwId/history?days=90`, `POST /sites/:id/ranks/refresh` (enqueues; meters serp_check) |
| `routes/content.ts` | `GET /sites/:id/content`, `POST /sites/:id/content {keywordId?,title,tone?,length?}` (limit: ai_words estimate), `GET /content/:id`, `PATCH /content/:id {title,outline,draft}`, `POST /content/:id/generate` (enqueues content job), `POST /content/:id/approve`, `GET /content/:id/export?format=html\|markdown` |
| `routes/onpage.ts` | `GET /sites/:id/onpage?url=` (suggestions for a crawled page), `POST /sites/:id/onpage/analyze {url}` (fetch+analyze single URL, LLM suggestions; meters ai_words) |
| `routes/backlinks.ts` | `GET /sites/:id/backlinks?status`, `POST /sites/:id/backlinks/refresh` (enqueues), `POST /sites/:id/backlinks/upload {csv}` (GSC UI export paste; dedupes) |
| `routes/geo.ts` | `GET /sites/:id/geo` (score + recent checks), `POST /sites/:id/geo/check {query, platforms?}` (limit: geo_checks; meters geo_check) |
| `routes/reports.ts` | `GET /sites/:id/reports`, `GET /reports/:id`, `POST /sites/:id/reports/generate` (enqueues report job) |
| `routes/settings.ts` | `GET /settings`, `PATCH /settings {notify_email, telegram_chat_id, llm_provider, llm_api_key?}`, `GET /usage` (per-limit used/limit) |

All `:id` params validated as UUID. All site-scoped routes verify
`site.tenant_id = req.tenant.tenantId` (helper `requireSite(tenantId, siteId)`).

---

## 6. Providers (`providers/`)

Interfaces in `types.ts`. Factories return real impl if env keys present,
else mock. **Never throw when keys are missing — use mock.**

```ts
interface LLMProvider {
  name: string; // 'gemini'|'openai'|'mock'
  generate(opts: { prompt: string; maxWords?: number; temperature?: number })
    : Promise<{ text: string; words: number }>;
  isMock: boolean;
}
interface KeywordSerpProvider {
  name: string; isMock: boolean;
  keywordMetrics(keywords: string[]): Promise<Array<{ keyword: string; volume: number|null; difficulty: number|null }>>;
  serp(keyword: string, domain: string): Promise<{ position: number|null; url: string|null; features: string[] }>;
}
interface PaymentsProvider {
  name: string; isMock: boolean;
  createCustomer(email: string, tenantId: string): Promise<{ customerId: string }>;
  createCheckoutSession(p: { customerId: string; planId: PlanId; successUrl: string; cancelUrl: string }): Promise<{ url: string; sessionId: string }>;
  createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }>;
  constructWebhookEvent(rawBody: Buffer|string, signature: string): Promise<{ type: string; data: any }>;
  // helper used by webhook route:
  applyEventToDb(evt: { type: string; data: any }): Promise<void>;
}
interface GoogleProvider {
  name: string; isMock: boolean;
  getAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<{ refreshToken: string }>;
  // stored refresh token passed in; impl decrypts/uses
  searchQueries(refreshToken: string, siteUrl: string, days?: number)
    : Promise<Array<{ query: string; clicks: number; impressions: number; position: number }>>;
  backlinks(refreshToken: string, siteUrl: string)
    : Promise<Array<{ sourceUrl: string; targetUrl: string }>>;
}
interface NotifyProvider {
  name: string;
  sendEmail(to: string, subject: string, html: string): Promise<void>;
  sendTelegram(chatId: string, text: string): Promise<void>;
}
```

- Caching: `KeywordSerpProvider` is wrapped by `services/keywordCache.ts`:
  metrics cache 30d (`keyword_metrics_cache`), SERP cache 7d (`serp_cache`
  key = `kw|domain`). Only uncached calls hit provider AND `recordUsage`.
- LLM calls: `services/llmMetered.ts` wrapper → `recordUsage(tenantId,'ai_words',words)`.

---

## 7. Queues & workers (`queues.ts`, `worker.ts`)

BullMQ. Queues: `crawl`, `rank-check`, `keyword-refresh`, `geo-check`,
`report`, `content`. Job name constants exported from `queues.ts`:

```ts
export const Jobs = {
  CRAWL_SITE: 'crawl-site', LIGHT_CHECK: 'light-check',
  RANK_CHECK: 'rank-check', KEYWORD_REFRESH: 'keyword-refresh',
  GEO_CHECK: 'geo-check', WEEKLY_REPORT: 'weekly-report',
  GENERATE_CONTENT: 'generate-content',
  BACKLINK_REFRESH: 'backlink-refresh',
} as const;
```

- `enqueue(queue, name, data, opts)` helper sets: `attempts: 3`,
  `backoff: { type: 'exponential', delay: 5000 }`,
  `jobId` = idempotency key (e.g. `crawl:${siteId}:${isoWeek}`),
  `removeOnComplete: 100, removeOnFail: 200`.
- Per-tenant rate limit: each queue has `limiter: { max: 20, duration: 60000 }`
  and processors check a Redis token bucket `rl:{tenantId}:{queue}` (10/min).
- **Idempotent handlers**: e.g. crawl handler checks for an audit with
  `status IN ('queued','running')` for the site before starting; rank handler
  skips keywords already checked today.
- Repeatable schedules are enqueued by API (`/audits` POST) or a `scheduler.ts`
  (worker process, node-cron): weekly crawls, weekly rank-checks per plan freq,
  weekly reports, monthly keyword refresh. Scheduler only enqueues (idempotent
  jobIds make it safe).
- `worker.ts` imports processors from `services/*` — each service exposes
  `registerXProcessors(workerHost)`.

---

## 8. Services & prompts

- `services/` holds pure-ish logic; fastify never imported there.
- Prompt templates in `src/prompts/*.txt` with `{{var}}` interpolation via
  `services/prompt.ts` `renderPrompt(name, vars)`.
- Crawler: `services/crawler.ts` — fetch with undici, cheerio parse, same-domain
  BFS up to plan `crawl_pages`, robots.txt respected, 5s timeout, 4 concurrency.
  Pure function `analyzePage(html, url)` exported for tests (no network).
- Audit rules (`services/auditRules.ts`): each rule
  `{ type, severity, check(page): IssueDraft|null, fix: string }`.
  Health score: `100 - min(90, Σ severity weights)` (error=10, warning=4, info=1)
  normalized per page.

---

## 9. Frontend (`frontend/`)

Next.js 14 App Router + TypeScript + Tailwind. API base URL: the browser
client (`lib/api.ts`) defaults to same-origin relative URLs;
`app/api/[...path]/route.ts` proxies `/api/*` to the API origin read from
the runtime environment per request (`API_INTERNAL_URL`, falling back to
`NEXT_PUBLIC_API_URL`, default `http://localhost:4000`) — the URL is never
baked into the image. Set `NEXT_PUBLIC_API_URL` as a build arg only for
non-proxied deploys where the browser must reach the API directly. (A
`next.config.js` rewrite cannot serve this purpose: rewrites are evaluated
at build time and serialized into the standalone server.)
Auth: httpOnly cookie `bseo_token` set by API on login/signup
(`POST /api/v1/auth/login` with `credentials:'include'`); `lib/api.ts`
wraps fetch with `credentials: 'include'`.

Pages:
- `/` marketing (product, pricing-teaser deferred note, CTA)
- `/login`, `/signup`
- `/dashboard` (sites list + add site)
- `/dashboard/sites/[id]` layout with tabs: Overview, Audit, Keywords,
  Rankings, Content, On-page, Backlinks, GEO, Reports
- `/dashboard/billing`, `/dashboard/settings`
- Onboarding wizard: `/dashboard/sites/new` (domain → verify → GSC connect → first audit)

`npm run build` must pass with zero errors. No dead buttons: every CTA
wired to a real API route (mock-backed is fine).

---

## 10. Testing

- `backend`: vitest. `npm test` runs with NO postgres/redis (unit tests use
  fakes/in-memory; DB-touching code tested via injected query fn).
- Required suites: tenancy scoping (every service query includes tenant_id —
  test via query-spy), metering/limits (402 paths), crawler rules
  (`analyzePage` fixtures), billing webhook (mock provider event application),
  job idempotency (handler skips duplicates), provider mock fallbacks.
- `frontend`: `next build` + `next lint` clean.

## 11. Docker

`docker-compose.yml`: `postgres:16`, `redis:7`, `api` (backend Dockerfile,
`node dist/index.js`), `worker` (same image, `node dist/worker.js`),
`web` (frontend Dockerfile, `next start`). Single `.env` file at root.
`docker compose up --build` must bring everything up; API runs migrations
on boot.

## 12. Non-negotiables checklist (integrator verifies)

- [ ] No route without auth except `/healthz`, auth routes, billing webhook.
- [ ] No SQL without `tenant_id` filter on tenant tables.
- [ ] No hardcoded secrets; `.env.example` complete.
- [ ] Every external call behind provider interface with mock fallback.
- [ ] Every expensive action metered; every limit enforced with 402.
- [ ] README complete; `docker compose up` works; `next build` clean.

## Addendum — Wave 2 Backend-A (LA-recorded, 2026-10-11)
- Invitation accept returns `{ ok, tenantId, role, token }` — fresh tenant-bound token; the pre-move token 401s after accept. Guards: `INVITE_WOULD_ORPHAN_DATA` / `INVITE_WOULD_ORPHAN_TENANT` (409).
- API keys: presented via `x-api-key` header or `Bearer bseo_…`; `INSUFFICIENT_SCOPE` 403 carries `missing[]`; `:write` scope implies `:read`; raw key shown once at creation, only sha256 hash stored.
- Tenant states: suspended → 403 `TENANT_SUSPENDED` everywhere; read-only → mutations blocked except billing/admin/account/apikeys/settings/auth/webhooks routes.
- Outbound webhooks signed `X-BSEO-Signature: sha256=<hmac(secret, "<ts>.<body>")>`; fixed event catalog; URL SSRF-validated at registration AND re-validated per delivery attempt.
- Admin: non-admins get 404 (not 403); impersonation = 5-min token, session-registered, always writes an admin audit row.
- `GET /api/v1/settings/providers` → `{ providers: [{ name, impl, mode: mock|real }] }`; `GET /api/v1/openapi.json` serves generated OpenAPI 3.1.
- Retention windows: usage 13mo, audits 12mo, webhook deliveries/DLQ 90d, activity log 24mo; soft-deleted sites hard-purged after 30d. Pending webhook retries are never swept; only resolved DLQ rows swept.
