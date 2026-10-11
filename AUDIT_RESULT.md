# AUDIT_RESULT.md — Audit findings (Audit Lead owned; auditors NEVER fix)

Severity: critical / high / medium / low. Each finding: file:line, reproduction, suggested fix.
Honesty rule: every finding verified by reading code or running it — no speculation.

## Baseline hostile audit — Wave 0 (2026-10-11)

Scope: entire repo as of `main@cc622a6` (worktree `~/workspace/beyonix-seo-tool/.worktrees/audit`, branch `agent/audit/work`).
READ-ONLY audit. Baseline verified this wave: `tsc --noEmit` exit 0; `npm test` 108/108 pass (7 files).

### §3 verification: P0-01..P0-05, S-01..S-10 vs actual code

| ID | Status | Evidence |
|---|---|---|
| P0-01 | CONFIRMED exactly as described | `backend/src/routes/auth.ts:135` — `/auth/login` calls `signToken(row.id, row.tenant_id)` (default `tv=0`) and never selects `users.token_version`. `auth.ts:155` — `/auth/logout` bumps `token_version`. `backend/src/middleware/auth.ts:59-62` rejects when `token_version != payload.tv` → after one logout, every password login mints `tv=0` ≠ DB (≥1) → "Session revoked" forever. Signup (`auth.ts:102`) also signs `tv=0` (works only because new users have `token_version=0`). Only the Google callback reads `token_version`. |
| P0-02 | CONFIRMED exactly as described | `backend/src/db.ts:24` `runMigrations()` — no advisory lock, each migration applied via plain `q(sql)` (no transaction). Both `api` (`backend/src/index.ts:57` `main()`) and `worker` (`backend/src/worker.ts:47`) call it at boot. `migrations/001_init.sql:5+` uses plain `CREATE TABLE` (no `IF NOT EXISTS`) → concurrent boot crashes one service or leaves a half-applied migration. `/healthz` (`index.ts:41`) is liveness-only; no readiness split (DB+Redis). |
| P0-03 | CONFIRMED exactly as described | `frontend/Dockerfile` — single-stage; `RUN npm run build` then `CMD ["npm", "run", "start"]` (ignores `output:'standalone'` in `frontend/next.config.js`). `frontend/lib/api.ts:6` reads `NEXT_PUBLIC_API_URL` (build-time inlined). `docker-compose.yml:60` passes `NEXT_PUBLIC_API_URL` as *runtime* env to `web` → silently ignored post-build. No build arg, no rewrite proxy, no standalone server. |
| P0-04 | CONFIRMED exactly as described | `backend/src/providers/stripe.ts:27` — `createCheckoutSession` sets `metadata: {planId, ...}` on the **session** only; no `subscription_data.metadata`. `config.stripePrices` is plan→price; no price→plan map exists. `applyPaymentEvent` (`stripe.ts:106`) reads `data.metadata?.planId` on `customer.subscription.updated` — real Stripe never sends it there → portal upgrades/downgrades ignored, tenant stuck on old plan. Additionally `checkout.session.completed` (`stripe.ts:93-99`) sets `current_period_end = now() + interval '30 days'` instead of Stripe's value. |
| P0-05 | PARTIALLY FIXED | (a) `backend/src/config.ts:10` still defaults `NODE_ENV=development`; `config.ts:57-65` now fails fast in production for missing/known-dev-default `JWT_SECRET` and non-64-hex `ENCRYPTION_KEY` (good). But: no `docker-compose.prod.yml` exists; `docker-compose.yml` never sets `NODE_ENV` → defaults to `development` → mock billing path live. Mock is allowed in *any* non-prod `NODE_ENV` (`stripe.ts` `getPayments()`), not only `test\|development`. (b) Prod check rejects only the single dev default; any weak non-empty secret (e.g. `secret`) passes — no 32-char/randomness enforcement despite the error message claiming "random 32+ char value". `.env.example` has empty `JWT_SECRET` → FATAL fires in prod, so the placeholder case is handled. (c) `MockStripeProvider.constructWebhookEvent` (`stripe.ts:76`) still ignores the signature; `/billing/mock-confirm` (`billing.ts:102`) is now auth+tenant-scoped (improvement) but still registered in all builds. In prod-without-keys it's unreachable only via `DisabledPaymentsProvider.isMock=false` side effect, not by build gating. |
| S-01 | CONFIRMED, nothing implemented | No `email_verified` column/flow anywhere (grep empty). `backend/src/providers/google.ts:32-41` `getProfile` never reads `verified_email`. `routes/auth.ts:185-196` merges by `google_id OR email` with no verification check. Mock Google (`google.ts:178`) returns fixed `mock.user@example.com` → mock OAuth can merge into an existing account with that email, no verification. |
| S-02 | CONFIRMED, core gap remains | `safeFetch` (`backend/src/services/safeFetch.ts:76`) validates DNS in `resolveChecked` but then calls plain `fetch()`, which re-resolves → TOCTOU DNS-rebinding still possible; no pinned-IP connect (no custom `undici` Agent/`lookup`), no Host/SNI pinning. `ipv6Blocked` does **not** block `64:ff9b::/96` or `2002::/16`; `::ffff:` handling covers only compact lowercase form, not expanded notation. No response-size cap, no content-type cap, no total crawl time budget (per-hop 8s abort only). Decimal/octal/hex IP encodings not explicitly normalized (only caught if the OS resolver happens to resolve them). Crawler itself correctly funnels through `safeFetch` (`services/crawler.ts:213`) — the boundary is honored, the primitive is weak. |
| S-03 | CONFIRMED | No `trustProxy` anywhere; `index.ts:31` registers `@fastify/rate-limit` with defaults (in-memory, per-instance). No Redis-backed store, no per-account limits, no login lockout/backoff. Auth endpoints have 20/min per-IP (`routes/auth.ts`), but behind a proxy `req.ip` is the proxy IP → all users share one bucket (and one attacker can exhaust it for everyone). |
| S-04 | CONFIRMED | `routes/auth.ts:22` `oauthStates` in-memory `Map`, not Redis, not bound to a browser cookie; `routes/gsc.ts:43` `gscStates` same pattern. No PKCE. GSC state embeds `{tenantId, siteId}` server-side (can't redirect linkage target), but `/auth/google/callback` login-CSRF variant remains: attacker initiates flow, victim completes it → victim's Google identity merged into attacker-chosen account context. |
| S-05 | CONFIRMED, nothing implemented | No password reset/change, email change, account+tenant delete/purge, TOTP, session list, "log out everywhere". No `routes/account.ts`. Logout only bumps `token_version` for the presented token's user. |
| S-06 | CONFIRMED (mostly) | No helmet, no CSRF tokens, no CSP/security headers in `frontend/next.config.js`. CORS is env-driven single origin (`index.ts:26` `origin: [config.appUrl]`) — acceptable. Cookie: `httpOnly`, `SameSite=lax`, `secure` in prod (`middleware/auth.ts:28-36`). **Gap:** `SameSite=lax` + cross-origin `fetch` (`credentials:'include'` from `frontend/lib/api.ts`) means with separate app/api domains in production the cookie is never sent on API calls (Lax only rides top-level navigations) → auth breaks; no SameSite strategy implemented. |
| S-07 | CONFIRMED | `backend/src/crypto.ts:15-17` — base64 `plain:` fallback still present in all envs (blocked in prod only by the config fail-fast requiring `ENCRYPTION_KEY`). No key versioning (`kid`), no rotation script. Separate secrets for JWT/encryption/webhook exist ✓. |
| S-08 | CONFIRMED | `routes/sites.ts:122` meta check is substring (`html.includes('bseo-verify') && html.includes(token)`) — token accepted anywhere in the page, not parsed from `<meta name="bseo-verify">`. `:125` file check is substring; `:128` TXT check is substring, not exact match. `dns.promises.resolveTxt` throws on NXDOMAIN (callers coerce to `false`, no NXDOMAIN distinction). No weekly re-verification (scheduler has no such job). `UNIQUE(tenant_id, domain)` only — two tenants can add and verify the **same** domain. |
| S-09 | CONFIRMED | `routes/onpage.ts:243-250` interpolates crawled page text (`textExcerpt` 1500 chars, title, meta, h1) into the prompt with no delimiting and no "treat as data" instruction. `content-outline`/`content-draft` interpolate user keyword/title/outline/tone; `geo-answer` interpolates `queryText`. No output schema validation (`parseSuggestions` falls back to displaying raw model text). No HTML sanitizer (DOMPurify etc.) anywhere in backend or frontend. (`contentEngine` escapes HTML in its own md→html helper — the only safe spot.) |
| S-10 | CONFIRMED | `backend/Dockerfile`: runs as root (no `USER`), `RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev` masks install failures, `node:24-alpine` unpinned digest. `docker-compose.yml:6,30,45` hardcodes `POSTGRES_PASSWORD: bseo` and `DATABASE_URL` with embedded creds (violates "compose requires env"); no `docker-compose.prod.yml`; no Redis auth, no resource limits. `frontend/Dockerfile`: single-stage, `npm run start` instead of the standalone server. |

### A1 — backend / API / security (NEW findings)

**[HIGH] N-A1-1 · Fastify schema-validation errors return HTTP 500/INTERNAL instead of 400.**
`backend/src/errors.ts:22-32` `errorEnvelope()` only handles `ApiError`; Fastify validation errors fall through to `500 {error:{code:'INTERNAL'}}`.
*Reproduction (ran against built app, no DB needed):* `POST /api/v1/auth/signup` with `{"email":"not-an-email"}` → `500 {"error":{"code":"INTERNAL","message":"body must have required property 'password'"}}`.
Every route with a JSON schema is affected. Also violates frozen contract §3.3 (validation → `VALIDATION_ERROR` 400) and leaks schema internals in non-prod.
*Fix:* in `errorEnvelope`, detect `err.validation` (Fastify `FST_ERR_VALIDATION`) → `400 VALIDATION_ERROR` with the validation message; add a test asserting 400 + code.

**[HIGH] N-A1-2 · Error envelope does not match the frozen contract.**
Contract (ARCHITECTURE_PLAN §3.3): `{ ok:false, error:{ code, message, requestId, details? } }`. Code emits `{ error:{ code, message, ...extra } }` — no `ok:false`, no `requestId` (`errors.ts:24`). Request-id middleware doesn't exist; Fastify logs show `reqId` internally but it's never attached to responses or error bodies.
*Fix:* add a request-id hook (`onRequest`, echo `x-request-id`), include `ok:false` + `requestId` in the envelope; update `frontend/lib/api.ts` error parsing.

**[MEDIUM] N-A1-3 · `checkTenantRateLimit` is dead code; README claims per-tenant job rate limits.**
`backend/src/queues.ts:56` defines the token-bucket limiter; zero call sites (verified by grep). README §"What's mock vs real" lists "per-tenant rate limits" under real BullMQ behavior → honesty gap.
*Fix:* wire it into `enqueue()` (or delete it and correct the README).

**[MEDIUM] N-A1-4 · `SameSite=lax` auth cookie breaks API calls on separate app/api domains.**
`backend/src/middleware/auth.ts:31-33`; frontend calls API via cross-origin `fetch` (`frontend/lib/api.ts:35` `credentials:'include'`). Lax cookies are not sent on cross-site fetch → in a split-domain production deploy every authenticated call 401s. (S-06 requires a SameSite strategy; none exists.)
*Fix:* env-driven `COOKIE_SAMESITE` (`lax` same-origin / `none`+`Secure` split-domain); document in `.env.example`.

**[MEDIUM] N-A1-5 · Concurrent `/billing/checkout` creates duplicate Stripe customers.**
`backend/src/routes/billing.ts:55-64`: read `stripe_customer_id` → `createCustomer` → `UPDATE`. Two concurrent calls both see NULL and both create real Stripe customers; the second `UPDATE` orphans the first (customer exists in Stripe, never referenced).
*Fix:* `SELECT ... FOR UPDATE` on the tenant row, or unique idempotency key per tenant.

**[MEDIUM] N-A1-6 · Mock Google profile enables account merge without verification (dev/test).**
`backend/src/providers/google.ts:178-180` returns fixed `mock.user@example.com`; `routes/auth.ts` callback merges by email. Anyone completing the mock OAuth flow takes over an existing account registered with that email. Low blast radius in prod (mock disabled when keys set), real in dev/staging.
*Fix:* gate the mock OAuth path behind explicit `NODE_ENV=test|development` and warn; or require the mock email to match an existing `google_id`.

**[LOW] N-A1-7 · Prod JWT check rejects only one known default; weak secrets pass.**
`backend/src/config.ts:61` — message says "random 32+ char value" but any non-empty, non-default value (e.g. `secret`) boots.
*Fix:* enforce `JWT_SECRET.length >= 32` (or 256-bit entropy check) in production.

**[LOW] N-A1-8 · `mock-confirm` still registered in all builds.**
`backend/src/routes/billing.ts:102`. Unreachable in prod only via provider-state side effect (`DisabledPaymentsProvider.isMock=false`), not by explicit gating (spec: remove in prod builds).
*Fix:* register the route only when `getPayments().isMock` at boot, or `NODE_ENV !== 'production'`.

### A2 — workers / queues / billing / data (NEW findings)

**[HIGH] N-A2-1 · No graceful shutdown in worker or API → in-flight jobs lost/duplicated on SIGTERM.**
`backend/src/worker.ts` and `backend/src/index.ts` install no `SIGTERM`/`SIGINT` handlers. Deploys/restarts kill BullMQ workers mid-processor; crawls lose progress, usage already recorded for uncompleted work, jobs re-run after visibility timeout (partial duplicate side effects, e.g. double notifications).
*Fix:* `worker.close()` / `app.close()` on signals; BullMQ drain per C-03.

**[HIGH] N-A2-2 · No scheduler leader election; `isoWeek` mixes local and UTC.**
`backend/src/worker.ts:60` `startScheduler()` runs in every worker process → N workers = N× cron ticks (idempotency keys dedupe *some* jobs, but every tick still does full-table scans and enqueue attempts). `scheduler.ts:8-15` `isoWeek()` builds `Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())` — local date interpreted as UTC → wrong week key near midnight for non-UTC `TZ`, breaking the idempotency dedupe it relies on.
*Fix:* Redis-redlock leader election for the scheduler (C-03); fix `isoWeek` to use UTC getters.

**[MEDIUM] N-A2-3 · Usage windows are calendar-month, not billing-period.**
`backend/src/metering.ts:29` `getUsage` windows on `date_trunc('month', now())`; `stripe.ts:93-99` sets `current_period_end = now() + interval '30 days'` instead of Stripe's `current_period_end`. Paying tenants are metered on calendar months while billed on subscription periods → over/under-enforcement at boundaries; period reset never aligns with Stripe.
*Fix:* store Stripe's `current_period_end`/period start on `customer.subscription.*` events (P0-04 fix covers the plumbing); window `getUsage` on the tenant's billing period (C-02).

**[MEDIUM] N-A2-4 · Metering is check-then-act; no reserve-then-commit.**
`checkLimit()` then later `recordUsage()` in separate calls (`routes/geo.ts:65-74`, `services/keywordCache.ts:33-46`, jobs). Concurrent requests/jobs both pass the check and overspend. `recordUsage` also floors units at 1 (`metering.ts:21` `Math.max(1, ...)`), so zero-cost calls still consume budget.
*Fix:* atomic reserve-then-commit (e.g. insert usage row first in the same transaction as the work, or Redis atomic counter) per C-02.

**[MEDIUM] N-A2-5 · Crawler has no response-size cap (memory DoS via huge pages/gzip bombs).**
`backend/src/services/crawler.ts:326` `await res.text()` with no byte budget; `safeFetch` caps neither size nor content-type. A malicious or pathological page can OOM the worker. Q-01's test plan explicitly wants gzip-bomb/redirect-loop fixtures — the code has no defense.
*Fix:* cap bytes in `safeFetch` (e.g. 5–10 MB, abort + error), enforce `content-type` allow-list for HTML paths.

**[MEDIUM] N-A2-6 · Webhook has no idempotency; signature optional unless secret set.**
`applyPaymentEvent` stores no processed event ids (C-01 gap). `RealStripeProvider.constructWebhookEvent` (`stripe.ts:44-48`) throws when `STRIPE_WEBHOOK_SECRET` is unset → in prod *with* Stripe keys but *without* the webhook secret, every webhook 500s → Stripe retry storm, events never processed, plans never apply. Fail-open config, fail-closed runtime.
*Fix:* require `STRIPE_WEBHOOK_SECRET` whenever `STRIPE_SECRET_KEY` is set; store processed event ids.

**[LOW] N-A2-7 · `/api/v1/settings/providers` missing (frozen contract §3.2).**
Contract requires every provider to report mock/real mode via this endpoint + README table. README table exists; endpoint does not (`routes/settings.ts` has `/settings`, `/usage` only).
*Fix:* add the endpoint backed by each provider's `isMock`.

**[LOW] N-A2-8 · OpenAPI not served (contract §3.5, C-07).**
No `/api/v1/openapi.json`; grep for `openapi` in `backend/src` returns nothing.
*Fix:* generate from the Fastify schemas (C-07).

### A3 — frontend / UX / docs / ops (NEW findings)

**[MEDIUM] N-A3-1 · `robots.txt` parser is naive; "respected" is only half true.**
`backend/src/services/crawler.ts:224-250`: no `crawl-delay` support (politeness); `appliesToAll` latches on the first `User-agent: *` and stays true for the rest of the file, so a later `User-agent: SomeBot` block's `Disallow`s are wrongly applied (and `Disallow` lines before any `User-agent` line are misattributed). README claims "robots.txt respected".
*Fix:* proper per-user-agent group parsing + crawl-delay honoring (C-04).

**[MEDIUM] N-A3-2 · No security headers in Next.js (S-06 frontend half).**
`frontend/next.config.js` has no `headers()` — no CSP, HSTS, `X-Frame-Options`, `Referrer-Policy`.
*Fix:* add `headers()` in `next.config.js` (S-06).

**[LOW] N-A3-3 · README "16-rule engine" vs 21 rules in code.**
`README.md` §mock-vs-real says "16-rule engine"; `backend/src/services/auditRules.ts` `RULES` contains 21 entries (counted `type:` entries in the array). Stale doc (understates; harmless but Q-04 must fix).

**[LOW] N-A3-4 · Signup/login leak JWT in JSON body while frontend uses only the cookie.**
`routes/auth.ts` returns `{ token, ... }` in the signup/login JSON; `frontend/app/signup/page.tsx` / `login` ignore the body token (cookie via `setAuthCookie`). The body token is readable by JS → wider XSS blast radius for no benefit.
*Fix:* stop returning the token in JSON (cookie is the mechanism), or document why both exist.

**[LOW] N-A3-5 · Mock-vs-real table over-claims on two points.**
README lists under "Real": "BullMQ jobs (retry/backoff, idempotent, per-tenant rate limits)" — per-tenant rate limits are dead code (N-A1-3); idempotency holds only where `idempotencyKey` is passed (scheduler + most routes do, but nothing enforces it). Also "Stripe **flow** (checkout → webhook → subscription row → plan upgrade)" — true only for the mock; the real flow is broken per P0-04. Table needs the P0-04 caveat until fixed.

### Tenant-isolation spot-check (all reads/updates sampled)
`requireSite(tenantId, siteId)` pattern is used consistently; every `UPDATE`/`DELETE` sampled (`routes/*.ts`, `services/*Jobs.ts`, `providers/stripe.ts`) carries `tenant_id` in the `WHERE` clause or is keyed by a prior tenant-scoped lookup. No cross-tenant leak found in sampled queries. Shared caches (`keyword_metrics_cache`, `serp_cache`) are intentionally tenant-agnostic with per-tenant cost accounting on miss (`services/keywordCache.ts:33-46`) — by design, acceptable.

## Regression audits (per phase gate)
(to be added)

## Final hostile audit loop (§9)
(to be added — fresh auditors, two consecutive clean passes required)
## Final hostile audit loop (§9) — PASS #1 (2026-10-11, LA session 3)

Three fresh auditors (A1: routes+services, A2: backend core/db/migrations/worker/crypto, A3: frontend+docs/secret-scan/deps), read-only. Raw reports: `.audit-pass1-a1.md`, `.audit-pass1-a2.md`, `.audit-pass1-a3.md`.

**Totals: 0 critical · 5 HIGH · 14 MEDIUM (unique, after dedupe) · 19 LOW.**

### HIGH (all must be fixed before pass #2)
| # | Finding | Location | Fix direction |
|---|---|---|---|
| A1-H1 | Audit double-submit/enqueue-failure leaves permanent orphan `queued` row → all future audits 409 forever | `backend/src/routes/audit.ts:68-105` | Partial unique index `(site_id) WHERE status IN ('queued','running')` + transactional check + mark `failed` on enqueue error |
| A1-H2 | Team roles unenforced: `requireScope` is a no-op for user sessions and zero of ~48 product mutation routes use `requireRole(OrScope)` — any viewer can delete sites, publish content, trigger crawls | `backend/src/routes/*.ts` (~48 routes) | Apply existing `requireRoleOrScope(['owner','admin','editor'], scope)` to all mutating domain routes |
| A2-H1 | Tenant BYOK LLM key sent to the WRONG provider (tenant OpenAI key → Google API query string) — live credential disclosure | `backend/src/providers/llm.ts:93-99` | Fail closed: never guess provider for a BYOK key; require explicit tenant provider |
| A2-H1b | (dup of A1-H2, same root cause in access.ts) | `backend/src/middleware/access.ts` | — |
| A2-H2 | Prod Docker image never ships `src/prompts/*.txt` → every LLM feature (content, GEO, on-page) throws ENOENT in production while tests stay green | `backend/Dockerfile:9-14` + `src/services/prompt.ts` | `COPY src/prompts ./dist/prompts` after build + build-smoke test |
| A3-H1 | Admin impersonation writes session JWT via `document.cookie` (JS-readable, no Secure) — defeats S-06 httpOnly design; XSS can steal the 5-min tenant session | `frontend/app/admin/page.tsx:130` | Backend issues impersonation session via `Set-Cookie: HttpOnly; Secure` |

### MEDIUM (unique)
| # | Finding |
|---|---|
| A1-M1 | Plan-limit enforcement is check-then-act everywhere; atomic `reserveUsage` exists but has zero production callers (overspend of plan limits + DataForSEO budget under concurrency) |
| A1-M2 | CSRF guard 403s legit API-key browser clients that also carry a session cookie (`x-api-key` not treated as non-ambient credential) |
| A1-M3 | `checkLimit('sites')` counts soft-deleted sites → Starter user blocked from replacing a deleted site for 30 days |
| A1-M4 | Slack dispatch validates webhook URL then uses raw `fetch()` — DNS-rebinding TOCTOU (use `safeFetch`) |
| A1-M5 | Admin plan override leaves tenant stuck `read_only` and `subscriptions` row `canceled` (out of sync) |
| A1-M6 | Checkout accepts client-controlled `trialDays` up to 90 — set trial length server-side |
| A1-M7 | Admin tenant-detail returns full row incl. `llm_api_key_enc` ciphertext |
| A2-M4 | Leader-election 30s TTL can expire mid-tick → duplicate digest emails + duplicate webhook deliveries (no atomic claim in either consumer) |
| A2-M5 | `incr`-then-`expire` race can permanently 429 a tenant/API key (key with no TTL) |
| A2-M6 | Fairness `moveToDelayed` + normal return likely double-executes heavy jobs in BullMQ |
| A2-M7 | GEO check prompt injects raw user query — no `delimitUntrusted` |
| A3-M1 | Rankings UI shows mock SERP data with no mock label (backend returns `dataSource`, frontend drops it) |
| A3-M2 | Keyword research volume/difficulty mock not labeled in KeywordsTab (gap panel labels it — inconsistent) |
| A3-M3 | `.env.example` missing real vars: NEXT_PUBLIC_API_URL, API_INTERNAL_URL, APP_HOST/API_HOST/APP_TLS_EMAIL, STRIPE_PRICE_*_ANNUAL, BSEO_REDIS_PREFIX, DB_STATEMENT_TIMEOUT_MS, LLM_TENANT_DEFAULT_CAP_WORDS, SEED_DEMO, MOCK_GOOGLE_* |

### LOW (19 — fix or justify each)
A1-L1 backlink CSV 5000 sequential INSERTs in request handler; A1-L2 `GET /metrics` unauthenticated (aggregate spend); A1-L3 CONTRACTS.md error-envelope shape doc drift; A1-L4 dead code (reserveUsage/commit/cancel if unused, `paged`, `GeoEngine`, `needsRankCheck`); A1-L5 `u(req)` "apikey:<id>" into UUID columns (latent 500); A1-L6 `PATCH /settings` accepts empty-string `llm_api_key`. A2-L1 `jwt.verify` without `algorithms` whitelist (3 sites); A2-L2 duplicate indexes (040 vs 001; api_keys_hash_idx vs UNIQUE); A2-L3 dead exports (`storeIdempotentResponse`, `currentKid`); A2-L4 CSRF `x-api-key` (dup of A1-M2, keep one); A2-L5 local coupon codes passed as Stripe coupon IDs (mock/real split); A2-L6 committed `usage_reservations` never purged; A2-L7 fairness slot TTL not heartbeated; A2-L8 migration numbering gaps (informational). A3-L1 settings inputs lack label association; A3-L2 test-fixture key.pem (synthetic, no action); A3-L3 invite debug token renders in UI on prod-without-SMTP; A3-L4 invite token in sessionStorage (accepted pattern, noted); A3-L5 `npm audit` limitation + no `engines` field.

### Explicitly clean slices (no finding)
Tenant isolation in all sampled SQL; SSRF via safeFetch (except A1-M4); billing webhook (sig/idempotency/ordering/plan-from-price); share tokens; authN/session incl. OAuth PKCE; GDPR erase coverage; migration runner semantics + all 29 migrations; crypto (GCM/random IV/kid); config fail-closed; idempotency middleware; invite-accept race; all 111 frontend endpoint×method pairs match backend; zero dangerouslySetInnerHTML; zero client console.log; token hygiene in auth flows; honesty labels (GEO simulated, insights projection, competitor unavailable, toxic heuristic, CMS mock); README mock-vs-real table matches code; secret scan clean (except synthetic fixture key).
