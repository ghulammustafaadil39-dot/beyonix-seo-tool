# Release Notes — Beyonix SEO Tool v1.0.0

**Version:** 1.0.0
**Release date:** 2026-10-11
**Status:** pending final gate (Wave 4 audit loop still running — see "Not yet verified" below)

A self-serve SEO + GEO SaaS for small businesses (and agencies): signup →
connect a website → technical audits, keyword research, rank tracking,
AI-written SEO+GEO content, backlink monitoring, AI-visibility (GEO)
tracking, competitor analysis, team workspaces, white-label reports, and a
public API. Monthly/annual billing via Stripe.

> **Verification numbers in this document are PRELIMINARY.** They are the
> last verified gate figures from `PROGRESS.md`. The Lead Architect will
> replace them with final numbers after the Wave-4 final gate.

---

## What's included

### Wave 1 — Security baseline (Phase 0 + Phase 1)

- **P0-01** Auth hardening: `token_version` read+signed in login/signup,
  per-session JWT revocation.
- **P0-02** Migrations made one-shot and safe: advisory lock, per-migration
  transaction, `/healthz` vs `/readyz` split.
- **P0-03** Frontend API proxy as a catch-all route reading
  `API_INTERNAL_URL` per request (build-time-safe).
- **P0-04** Stripe price→plan mapping (`STRIPE_PRICE_*` as single source of
  truth) with signed offline fixture tests.
- **P0-05** Fail-closed secrets validation (`validateSecrets()`), signed mock
  webhooks, mock-confirm disabled in production.
- **S-01** Email verification; Google↔local account merge requires
  `email_verified` on both sides; `requireVerifiedEmail` on paid/spend routes.
- **S-02** `safeFetch`: DNS pinning, redirect re-validation, IPv6-transition
  blocks, size/type caps (SSRF defense; test-only loopback bypass provably
  unreachable otherwise).
- **S-03** Redis rate limits, login lockout, CAPTCHA hook for signup abuse.
- **S-04** Redis OAuth state + signed cookie + PKCE.
- **S-05** Password reset/change, email change, account delete+purge,
  TOTP 2FA (incl. backup codes), session list/revocation.
- **S-06** HttpOnly cookies, CSRF double-submit, Helmet/CSP (incl. Next.js
  headers), env-driven CORS.
- **S-07** Encryption key versioning (`kid`) + rotation script.
- **S-08** Site domain verification (meta/file/DNS) + weekly re-verification.
- **S-09** Prompt-injection delimiting + LLM HTML sanitization.
- **S-10** Container hardening (reviewed; image scan deferred to CI).

### Wave 2 — Billing, reliability, features (Phase 2 + Phase 3)

**Billing/data/reliability (C-01…C-07):**

- **C-01 Billing completeness** — idempotent Stripe webhook handling
  (`stripe_webhook_events` ledger), all period/status/plan values read from
  Stripe (never `now()+30d`), trials, coupons (Stripe-coupon id mapping),
  annual plans, dunning emails, grace period, usage-aware downgrades
  (read-only mode instead of deleting data), invoices UI, replay-safe
  signature verification, checkout blocked when already subscribed
  (portal for changes).
- **C-02 Metering correctness** — reserve-then-commit atomic usage,
  billing-period windows, per-feature usage dashboard + 80/100% alerts,
  DataForSEO spend tracking per tenant, hard 402 stops with upgrade prompts.
- **C-03 Queue reliability** — BullMQ with per-tenant fairness, graceful
  shutdown, dead-letter queue with replay, scheduler leader election,
  circuit breakers, UTC-consistent scheduling, backpressure.
- **C-04 Crawler v2** — robots.txt + crawl-delay respected, redirect-chain/
  loop analysis, canonical/hreflang/sitemap parsing, simhash duplicate
  detection, orphan pages, internal-link graph, structured-data validation,
  image checks, PageSpeed (cached, quota-guarded), incremental recrawl
  (ETag/If-Modified-Since), crawl resume. *Exception: optional Playwright
  JS-rendering mode deferred — JS-rendered pages are audited as static HTML.*
- **C-05 Rank tracking v2** — full SERP snapshots (top 100), device/location/
  language tracking, SERP-feature detection, pixel-rank/visibility share,
  shared cross-tenant cache with cost accounting.
- **C-06 Data lifecycle** — retention policies + cleanup jobs, soft-delete
  with restore window, backup/restore scripts, tenant data export,
  EXPLAIN-verified indexes.
- **C-07 API quality** — validation on every route, consistent error codes,
  stable pagination, OpenAPI 3.1 served live, versioned `/api/v1`,
  idempotency keys, request ids in logs and error bodies.

**Product features (F-01…F-14):**

- **F-01** Onboarding checklist (verify → connect GSC/GA4 → first crawl →
  keywords → first report) with backend-sourced progress state.
- **F-02** Audit v2: impact prioritization, grouped fixes, ignore/resolve/
  won't-fix, crawl-to-crawl diffs, regression alerts, shareable audit links
  (HMAC-signed, revocable), PDF/CSV export, scheduled crawls per plan.
- **F-03** Keyword research v2: seed expansion, intent clustering, question
  keywords, cannibalization detection, keyword gap vs competitors, lists/
  tags, bulk import/export.
- **F-04** Content engine v2: brief → outline → draft → optimize workflow,
  NLP term coverage vs top results, internal-link suggestions, alt/meta/
  schema generation, brand-voice profiles, version history, approval flow,
  HTML/Markdown/DOCX export, optional WordPress/Webflow publish connector.
- **F-05** GEO/AI-visibility v2: multi-engine checks (ChatGPT, Perplexity,
  Gemini, Claude, AI Overviews), prompt sets, citation/mention/sentiment,
  share-of-voice, llms.txt/schema recommendations, history charts.
  *GEO checks are simulated via our LLM, always labeled `simulated: true`.*
- **F-06** Backlinks v2: GSC links, new/lost tracking, toxic flags, anchor
  distribution, opportunity finder, disavow generator.
- **F-07** Competitor analysis: per-site competitors, visibility/keyword/
  content/backlink comparison.
- **F-08** Reporting v2: white-label PDF/HTML (logo + colors), scheduled
  email delivery, plain-language executive summary, period comparison,
  client share links, custom sections.
- **F-09** Agency & team: multi-user tenants (owner/admin/editor/viewer),
  email invitations, activity log, per-client workspaces.
- **F-10** Notifications: email, Telegram, Slack, signed webhooks; per-user
  alert rules; digest settings; in-app center.
- **F-11** Billing UI: pricing page, upgrade/downgrade via Stripe portal,
  usage meters, invoices, billing email, cancellation flow, coupons, annual
  toggle.
- **F-12** Marketing site: landing, docs, legal (terms/privacy/DPA),
  cookie banner, sitemap/robots.
- **F-13** Public API: scoped API keys, rate limits, webhook subscriptions,
  OpenAPI docs page.
- **F-14** Admin back-office: tenants, plans, usage, failed jobs, provider
  spend, suspend/unsuspend, impersonation-with-audit, feature flags, system
  health, manual plan override, refund/credit helpers.

### Wave 3 — Quality, ops, world-class (Phase 4 + Phase 5)

**Quality/ops (Q-01…Q-05):**

- **Q-01** Full test pyramid: API integration tests (real Postgres+Redis)
  with role matrix and cross-tenant isolation on every resource, provider
  contract tests, signed Stripe fixtures, worker crash/retry/idempotency
  tests, crawler fixtures (incl. malicious pages), migration tests,
  Playwright E2E journey, chaos tests, security tests (IDOR/SSRF/XSS/CSRF/
  rate-limit). Backend core coverage ≥ 85%.
- **Q-02** GitHub Actions CI: lint, strict `tsc`, tests with services,
  `npm audit`, secret scan, Trivy, migration dry-run, E2E, artifacts.
  *(CI YAML validated; execution happens in GitHub Actions only.)*
- **Q-03** Observability: pino JSON logs, Prometheus `/metrics`, `/status`
  endpoint, alert rules, admin status page.
- **Q-04** Docs: README/RUNBOOK/ARCHITECTURE/SECURITY/CHANGELOG refresh,
  methodology doc, compliance notes, `.env.example` proven complete
  (every variable the backend reads is documented there; exact count not
  quoted — it changes as knobs are added).
- **Q-05** Deployment: `docker-compose.prod.yml` (reverse proxy + TLS,
  healthchecks, resource limits, backup sidecar), backup/restore scripts,
  rolling-deploy notes. *(Compose files statically validated; never booted
  in this environment.)*

**World-class (W-01…W-09):**

- **W-01** Scale: API/worker/scheduler split, per-tenant fairness, global
  provider spend circuit, load-test proof.
- **W-02** Data moat: keyword/SERP cache with provenance (30d metrics /
  7d SERP TTLs), provider fallback, anomaly detection on rank data.
- **W-03** AI layer: model routing (cheap bulk / strong drafts), prompt
  registry with golden evals, per-tenant LLM cost caps, tenant BYOK
  (fail-closed — see below), brand-voice memory, approval gates.
- **W-04** Insights engine: prioritized "do this next" actions with
  estimated impact, traffic-drop detection with likely-cause explanation,
  traffic forecast.
- **W-05** Real-time UX: SSE job progress (with polling fallback), command
  palette, keyboard shortcuts, skeletons, optimistic UI with rollback,
  i18n scaffold (en complete; ur/ar stubs). *(axe ruleset needs a browser;
  documented as deferred.)*
- **W-06** Extensibility: plugin contract, signed webhook event catalog
  (`audit.completed`, `rank.changed`, `report.ready`, …) with retries and
  replay, reference Slack plugin.
- **W-07** Compliance: GDPR export (bearer-token redaction) + transactional
  erase, security.txt, SOC2-style control checklist.
- **W-08** Performance: p95 wins on hot endpoints, query budget tests.
- **W-09** Developer quality: strict TS, OpenAPI-generated client, ESLint,
  property-based tests, seed script, one-command `make dev`.

### Wave 4 — Final audit loop (in progress)

- Pass #1 (3 fresh hostile auditors): 0 critical / **5 HIGH** / 14 medium /
  19 low findings → all fixed, regression-tested, merged to main; security
  re-review: 4/5 HIGH approved, 1 changes-requested fixed+tested by the LA
  (per-audit BullMQ job ids, BYOK guard hardening).
- Fixes included: BYOK key fail-closed (A2-H1), Dockerfile prompts
  packaging, share-route role guards, metering reserve dead-code removal,
  leader-election TTL, rate-limiter incr/expire race, GEO prompt-injection
  delimiting, impersonation moved to server-side httpOnly cookie flow
  (A3-H1).
- Pass #2 (3 fresh auditors): complete — 1 HIGH + 9 medium + 21 low found;
  all fixed, regression-tested, merged to main.
- Pass #3 (5 auditors): 4 HIGH + 20 medium + 33 low → all fixed
  (incl. Stripe cancel-on-delete/erase, atomic coupon redemption).
- Pass #4 (5 auditors): 4 HIGH + 10 medium + 19 low → all fixed; LA product
  decision: new signups get a server-side 14-day trial (Starter quota),
  read-only after expiry.
- Pass #5 (5 auditors): 2 HIGH + 7 medium + lows → all fixed (scheduler
  billing-liveness filter, `incomplete` removed from billable, webhook
  supersede guards, trial-gate wiring, postcss CVE override).
- Pass #6 (4 auditors): 1 new MEDIUM (scheduler still authorized `incomplete`
  for scheduled spend) + 14 lows → all fixed (incl. webhook event-id
  idempotency guards, trial-UX labels).
- Pass #7 (5 auditors): 1 HIGH (CVE-2026-23869 in next@14 — remediated via
  Next 15.5.15 upgrade) + 3 medium (account-security UI gap, checkout
  `incomplete` clobber, invoice.paid recovery) + 5 lows → all fixed.
- Pass #8 (next): the first of the two consecutive clean passes required
  before delivery (zero new medium-or-higher findings).

---

## Verification summary (PRELIMINARY — LA to fill final)

| Check | Last verified figure | Source |
|---|---|---|
| Backend test suite | **689 passed / 9 skipped / 0 failed** (81 files) | main, post pass-#1 merge, 2026-10-11 ~19:20 PKT |
| Wave-3 gate (definitive post-rebase) | 646 passed / 9 skipped / 0 failed (72 files) | LA, 2026-10-11 ~17:45 PKT |
| Wave-2 gate | 577 passed / 9 skipped / 0 failed (59 files) | LA, 2026-10-11 ~12:15 PKT |
| Wave-1 gate | 307 passed / 9 skipped / 0 failed | LA, 2026-10-11 ~02:00 PKT |
| Backend coverage (core) | **86.19% lines** (gate criterion ≥ 85%) | LA re-run on main, 2026-10-11 ~18:10 PKT |
| TypeScript | `tsc --noEmit` clean | each gate |
| Frontend | `next build` green | each gate |
| Playwright E2E (real Chromium, headless) | **5/5 PASS** (login→dashboard, billing, logout→login, fresh signup, /status) | Wave-3 gate |
| Audit passes | pass #1: 5H/14M/19L all fixed+verified; pass #2: 1H/9M/21L found, fixes in progress | AUDIT_RESULT.md |
| Lint | ESLint configured (Q-02); strict TS everywhere | Wave-3 |

**Load/chaos (verified):** 88k-request load baseline (p95 185ms), worker
honest load proof (10 tenants, 18 jobs/s, fairness measured), chaos DLQ
3/3 (real worker process, kill-mid-job), Node load baseline in CI.

---

## Known limitations (honest)

1. **No Docker daemon in the build VM — `docker compose` was never
   executed here.** Both `docker-compose.yml` and `docker-compose.prod.yml`
   are statically validated (YAML) but have never been booted. This is a
   recorded user decision (2026-10-11): work continued natively; if Docker
   access arrives later, it will be used for final-gate verification.
2. **Trivy image scan not run** (requires built Docker images) — must run
   in CI (Q-02).
3. **`npm audit` was registry-blocked** (`policy_denied`) in this
   environment — must run in CI / on the delivery machine.
4. **Crawler Playwright mode deferred (C-04 exception):** JS-rendered pages
   are audited as static HTML; all fetches go through `safeFetch`.
5. **axe accessibility ruleset needs a browser:** axe-core is importable but
   the ruleset was not executed in the VM — rerun in CI or staging.
6. **No real-browser pass for TOTP login autofill/mobile keyboards** —
   recommend a manual staging check.
7. **Migration number gaps:** migrations `008`, `009`, `031`–`039` were
   never issued; 32 additive files cover `001`–`007`, `010`–`030`,
   `040`–`043`. Harmless (the ledger skips by name), noted for honesty.
8. **`compose.prod.yml` was not boot-tested** (see #1); same-origin proxy /
   TLS config is file-reviewed only.

---

## Upgrade / migration notes

- Migrations live in `backend/migrations/NNN_name.sql` and are **additive
  only** — never edit an applied migration; new schema ships as a new
  numbered file.
- One-shot runner: `node dist/migrate.js`. It uses an advisory lock, runs
  each migration in its own transaction, and records it in the `migrations`
  ledger. The API and worker also run it (advisory-locked) at boot.
- **Fresh install:** apply all 32 files in order on an empty database
  (`make dev` does this, plus seeding).
- **Upgrade from any earlier build:** just deploy + boot — pending
  migrations apply automatically. Wave ranges: `001`–`030` (Waves 0–2),
  `040` (Wave 3), `041`–`043` (Wave 4). No data-migration or backfill steps
  are required; every change is additive.
- Historical note: migration `003` was edited before it was ever applied
  anywhere (contract exception recorded in PROGRESS.md); the file on disk
  matches what ran.

---

## What's mock vs real (honest table — verified in code)

*Real* = calls the actual third party. *Mock* = deterministic local
stand-in, always labeled. The rule holds everywhere: **anything left empty
runs in mock mode.**

| Integration | Real when… | Mock/fallback behavior | Env config | Code |
|---|---|---|---|---|
| **Stripe billing** | `STRIPE_SECRET_KEY` (+ `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*`) → real checkout sessions, customer portal, webhook signature verification via the Stripe SDK | Dev/test: mock provider, mock-confirm URL completes the flow locally; mock webhooks signed with `MOCK_WEBHOOK_SECRET`. **Production without keys → `DisabledPaymentsProvider`: every billing op fails closed with 503.** | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER/GROWTH/PRO` (+ `_ANNUAL`) | `backend/src/providers/stripe.ts` |
| **DataForSEO** (keyword volume/difficulty, SERP, competitor keywords) | `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` → real `api.dataforseo.com` v3 calls (search volume, organic keyword difficulty via Labs, live SERP, Labs ranked keywords); circuit-broken, cached **30d (metrics) / 7d (SERP)** with provenance | Deterministic seeded mock (`dataSource: 'mock'` on responses) | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | `backend/src/providers/dataforseo.ts`, `backend/src/services/keywordCache.ts` |
| **LLM** (content drafts, GEO checks, insights) | `GEMINI_API_KEY` → real Gemini; `OPENAI_API_KEY` → real OpenAI. Tenant BYOK honored (`llm_provider` + encrypted `llm_api_key_enc`); **fail-closed: a BYOK key with no explicit provider is never sent anywhere (throws instead of guessing)** | Structured template drafts, labeled mock | `GEMINI_API_KEY` / `OPENAI_API_KEY`, `LLM_PROVIDER`; tenant `llm_provider`/`llm_api_key_enc` | `backend/src/providers/llm.ts` |
| **Google OAuth / GSC / GA4** | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` → real OAuth (PKCE, Redis state), real Search Console queries, backlinks and GA4 properties/overview | Mock provider (fixed sample profile/data) **only in test/development** — `isMockGoogleAllowed()` fails closed in production without credentials | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | `backend/src/providers/google.ts` |
| **Email (SMTP)** | `SMTP_HOST` (+ port/user/pass) → real delivery via nodemailer | Logged to console | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | `backend/src/providers/notify.ts` |
| **Telegram** | `TELEGRAM_BOT_TOKEN` → real `sendMessage` | Logged to console | `TELEGRAM_BOT_TOKEN` | `backend/src/providers/notify.ts` |
| **Slack** | Tenant configures a webhook URL in notification settings → real POST | No-op with clear "not configured" error | notification settings (per tenant), not env | `backend/src/services/notifications.ts` (`sendSlack` via `safeFetch`) |
| **Outbound webhooks** (F-10, W-06) | Real: HMAC-signed (`X-BSEO-Signature`) POSTs to tenant endpoints, retries + replay | — (no mock path; endpoints are tenant-supplied) | tenant webhook subscriptions | `backend/src/services/webhookDelivery.ts` |
| **CMS publish** (F-04) | `CMS_PUBLISH_ENABLED=true` + per-request credentials → real WordPress REST / Webflow CMS publish | **Honest mock: returns `{ ok: true, mock: true }`, performs zero network calls** | `CMS_PUBLISH_ENABLED` (credentials are supplied per publish request, not via env) | `backend/src/services/publishConnector.ts` |
| **GEO / AI visibility** (F-05) | — | **Simulated by design:** our LLM generates a platform-style answer, then we detect brand mentions; every row carries `simulated: true`. Never presented as real platform data. | follows LLM config | `backend/src/services/geoService.ts` |
| **CAPTCHA** (signup) | `CAPTCHA_PROVIDER=hcaptcha` + `CAPTCHA_SECRET` → real hCaptcha verification, fail-closed on error | `none` (default); `test` provider **refused outside test/development** | `CAPTCHA_PROVIDER`, `CAPTCHA_SECRET` | `backend/src/providers/captcha.ts` |
| **Crawler** (C-04) | Real HTTP crawling with full SSRF defense (`safeFetch`: DNS pinning, redirect re-validation) | No JS execution — Playwright mode deferred; pages audited as static HTML | — | `backend/src/services/crawler.ts` |
| **PageSpeed** (CWV) | Real: Google PageSpeed API v5 (free, no key), results cached 7 days, daily quota enforced | — | — | `backend/src/services/pagespeed.ts` |
| **Backlinks** (F-06) | Real via GSC (Google provider) when Google is configured | GSC sample links otherwise; DataForSEO backlinks API **not wired** | follows Google config | `backend/src/services/backlinkJobs.ts` |
| **Report export** | Real PDF/HTML/DOCX generation | — | — | `backend/src/services/pdf.ts`, `backend/src/services/docxExport.ts` |

---

## Not yet verified (final gate checklist — LA)

- [ ] Wave-4 **passes #8 and #9**: two consecutive clean passes with no new
      medium-or-higher findings (passes #1–#7 complete, all findings fixed).
- [ ] Final numbers on main: full test suite, coverage ≥ 85%, E2E, load +
      chaos, strict `tsc`, lint clean.
- [ ] `docker compose up --build` smoke from a wiped machine (deferred per
      user decision — needs Docker access).
- [ ] Trivy image scan + `npm audit` (CI / delivery machine).
- [ ] Production deploy files work from a wiped machine with only `.env`
      created.
- [ ] Playwright E2E re-run on final main.
- [ ] axe ruleset executed with a real browser.
- [ ] Docs / `.env.example` / OpenAPI / README final consistency sweep
      against the shipped code.

---

*Prepared by Delivery-Prep (DOCS), 2026-10-11. Numbers marked PRELIMINARY;
the Lead Architect fills the final figures at the final gate.*
