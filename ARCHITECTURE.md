# Beyonix SEO Tool — Product Architecture (v1)

**Product:** Self-serve SEO + GEO SaaS for any business
**Model:** Customer signs up → connects website → tool runs audits, keywords, rank tracking, content, reports. Monthly subscription.
**Status:** Draft for discussion — kuch decisions (neeche "Open Questions") abhi baat karke final honge.

---

## 1. Product ek line mein

"Apni website connect karo — tool khud technical audit karega, keywords dhoondega, rankings track karega, SEO+AI-search optimized content likhega, aur plain-language reports dega."

**Positioning (Ahrefs/SEMrush se farq):** woh tools data dikhate hain, expert chahiye samajhne ke liye. Hamara tool **kaam karke dega** — non-expert business owner ke liye bana hai: plain-language, action-first, aur GEO (AI search visibility) built-in jo purane tools mein nahi hai.

---

## 2. High-Level Architecture

```
                    ┌──────────────────────────────────┐
                    │        Frontend (Next.js)         │
                    │  Dashboard · Reports · Billing    │
                    │  Onboarding · Content editor      │
                    └───────────────┬──────────────────┘
                                    │ HTTPS / REST API
                    ┌───────────────▼──────────────────┐
                    │        Backend API (Node.js)       │
                    │  Auth · Tenancy · Subscriptions   │
                    │  Usage metering · Plan limits     │
                    └───────┬──────────────┬───────────┘
                            │              │
              ┌─────────────▼──────┐  ┌────▼──────────────┐
              │  Postgres (RDS/    │  │  Redis + Job Queue │
              │  self-hosted)      │  │  (BullMQ)          │
              │  tenant_id on      │  │                    │
              │  every row         │  └────┬───────────────┘
              └────────────────────┘       │ jobs
                                     ┌─────▼────────────────────────┐
                                     │        Workers                │
                                     │ ┌──────────┐ ┌────────────┐  │
                                     │ │ Crawler  │ │Rank checker│  │
                                     │ │(audit)   │ │(SERP API)  │  │
                                     │ └──────────┘ └────────────┘  │
                                     │ ┌──────────┐ ┌────────────┐  │
                                     │ │ Content  │ │Backlink +  │  │
                                     │ │ engine   │ │GEO monitor │  │
                                     │ │(LLM)     │ │            │  │
                                     │ └──────────┘ └────────────┘  │
                                     └──────────────────────────────┘
                                            │         │
                              ┌─────────────▼──┐ ┌───▼──────────────┐
                              │  LLM API        │ │ External data     │
                              │  (pluggable:    │ │ APIs (pay-as-you- │
                              │  Gemini/GPT)    │ │ go, cached)       │
                              └─────────────────┘ └───────────────────┘
```

**Sab kuch ek VPS par start hoga** (API + workers + Postgres + Redis). Scale par workers alag ho sakte hain — code mein pehle din se alag rakha jayega taake move karna easy ho.

---

## 3. Tech Stack (cheapest lekin mature)

| Layer | Choice | Kyun |
|---|---|---|
| Frontend | Next.js (React) | Dashboard + marketing site ek hi codebase; fast |
| Backend API | Node.js (TypeScript) + Fastify/Express | Ek language mein full-stack, hiring easy |
| Database | Postgres, har row par `tenant_id` | Day-1 multi-tenancy; baad mein migrate nahi karna parega |
| Jobs | Redis + BullMQ | Crawls/rank-checks background mein, retry + rate-limit built-in |
| Crawler | Custom (Playwright/Cheerio-based) | Audit ke liye paid API nahi chahiye — khud crawl karo |
| LLM | Pluggable (Gemini Flash default, GPT optional) | Sasta default; customer apni API key bhi laga sake (BYOK) |
| Keyword/SERP data | DataForSEO (pay-as-you-go) + aggressive caching | **Ye woh cost hai jo zero nahi ho sakti** — real keyword volume data free mein reliable nahi milta. Cache + weekly checks se control mein rakho |
| Backlinks | GSC links API (free) → baad mein DataForSEO | Start free, upgrade jab revenue aaye |
| Billing | Stripe | Standard; free until revenue |
| Auth | Email + Google OAuth, JWT sessions | Simple, standard |
| Hosting (start) | 1 VPS ~$6–8/mo (Hetzner/DigitalOcean) | API + workers + DB + Redis sab ek par |

**Mature-cheap usool:** mehngi cheez (keyword/SERP data) ko cache karo aur plan ke hisaab se limit karo; sasti cheez (crawl, DB, reports) khud banao.

---

## 4. Modules

### 4.1 Auth, Tenancy & Billing
- Signup (email/Google), workspace per customer (agency ek account se multiple client sites chala sake — future)
- Har table mein `tenant_id`; API layer mein automatic scoping (kabhi doosre customer ka data leak na ho)
- Stripe subscriptions: plan limits enforce (sites count, keywords tracked, AI words/month, crawl pages)
- Usage metering: har expensive action (SERP check, AI generation) count ho, limit cross par soft-block + upgrade prompt

### 4.2 Onboarding / Site Connect
- Customer domain add kare → tool verify kare (DNS/meta tag/file — simple)
- Google Search Console connect (OAuth) → free ka sab se valuable data: impressions, clicks, actual ranking queries
- GA4 optional connect
- Pehla "health score" 2–5 min mein — onboarding ka wow moment

### 4.3 Site Audit Crawler
- Khud ka crawler: poori site crawl → broken links, missing/duplicate meta, title length, H1 issues, images bina alt, slow pages (PageSpeed API free), mobile issues, schema presence, robots/sitemap check
- Har issue: severity + **plain-language fix** ("ye title 70 characters se lamba hai — chhota karo, keyword aage rakho")
- Schedule: weekly full crawl, daily light check (homepage + new pages)

### 4.4 Keyword Research
- Seed: GSC ki actual queries (free, gold) + customer ke services
- Expand + metrics (volume, difficulty, intent): DataForSEO pay-as-you-go, results DB mein cache (dobara charge nahi)
- Output: prioritized list — "low competition, tumhare business se match" — plain language reason ke saath
- Keyword grouping: ek topic = ek content piece (cannibalization avoid)

### 4.5 Rank Tracker
- Tracked keywords ke liye weekly SERP check (DataForSEO), position history graph
- Plan-based frequency: cheap plan weekly, higher plan daily
- Alert: bara drop/rise → notification

### 4.6 Content Engine (SEO + GEO)
- Keyword → outline → draft → **GEO formatting**: 40–60 word direct-answer opening, FAQ section, Article/FAQ schema suggestion, citation-ready stats placement
- Tone/length settings per site; cheap LLM default, quality review customer ka (approve/edit/publish)
- AI-detection-safe approach: human-in-loop rakho — tool draft de, customer final kare. Ye quality + Google policy dono ke liye zaroori hai
- Usage: AI words/month plan limit mein

### 4.7 On-Page Optimizer
- Har page ke liye: meta title/description suggestions, internal link suggestions, schema snippets (copy-paste ready), content gap ("competitor ke paas ye section hai, tumhare paas nahi")

### 4.8 Backlink Monitor
- Start: GSC links (free) — new/lost links weekly
- Baad mein: DataForSEO backlinks (paid) jab revenue justify kare
- Toxic-link/disavow workflow: v2 (needs a real link-quality data source; v1 must not label links "toxic" without one)

### 4.9 AI Visibility / GEO Tracker (differentiator)
- Target queries ChatGPT/Perplexity/Gemini ko periodically poochho (API se) → brand mention hua ya nahi, kis position/context mein
- AI-referral traffic GA4 se track
- "GEO score" per site — ye hamara unique selling point, purane tools mein nahi

### 4.10 Reporting Dashboard
- Plain-language weekly report: "kya badla, kya karna hai" — non-expert samajh sake
- White-label PDF export (agency customers ke liye — future upsell)

### 4.11 Notifications
- Email + (Telegram optional): rank alerts, crawl issues, weekly summary, content ready for review

---

## 5. Data Model (core tables)

```
tenants (id, name, plan_id, stripe_customer_id, created_at)
users (id, tenant_id, email, role)
sites (id, tenant_id, domain, verified, gsc_connected, ga4_connected)
audits (id, site_id, started_at, finished_at, score, issues_count)
audit_issues (id, audit_id, site_id, type, severity, url, detail, fix_suggestion, status)
keywords (id, site_id, keyword, volume, difficulty, intent, priority_score, added_from)
rank_checks (id, keyword_id, checked_at, position, url, serp_features)
content_pieces (id, site_id, keyword_id, title, outline, draft, status[draft/review/approved], ai_words_used)
geo_checks (id, site_id, query, platform, mentioned, context_snippet, checked_at)
backlinks (id, site_id, source_url, target_url, first_seen, last_seen, status)
usage_events (id, tenant_id, site_id, event_type, units, created_at)   -- metering
subscriptions (id, tenant_id, stripe_sub_id, plan_id, status, current_period_end)
```

---

## 6. Background Jobs (BullMQ queues)

| Queue | Schedule | Kaam |
|---|---|---|
| `crawl` | Weekly per site + daily light | Full audit |
| `rank-check` | Weekly (cheap plan) / daily (pro) | SERP positions |
| `keyword-refresh` | Monthly | Volume/difficulty refresh |
| `geo-check` | Weekly | AI platform mentions |
| `report` | Weekly | Summary generate + send |
| `content` | On-demand | Draft generation (user triggers) |

Har job: retry with backoff, per-tenant rate limits, idempotent (dobara chalne par duplicate na bane).

---

## 7. AI Strategy (cost control)

- **Default cheap:** Gemini Flash (ya equivalent) — drafting, summaries, suggestions
- **BYOK:** customer apni API key lagaye to uska kharcha, hamara zero
- **Plan-gated:** AI words/month limit per plan; content engine higher plans mein zyada
- **Prompt templates versioned** (DB ya files mein) — improve bina deploy ke
- **Human-in-loop:** publish se pehle approve — quality + trust dono

---

## 8. Security / Isolation (mature hone ke liye lazmi)

- `tenant_id` scoping har query mein (middleware, bhoolne par bhi leak nahi)
- Customer sites ka crawl data sirf usi tenant ko
- API keys (GSC tokens, LLM keys) encrypted at rest
- Rate limiting per tenant (ek customer doosre ki jobs na rok sake)
- Audit log: kaunsi action kisne ki (billing disputes ke liye)

---

## 9. Cost Estimate (cheapest-mature, launch time)

| Item | Monthly |
|---|---|
| VPS (API + workers + Postgres + Redis) | ~$6–8 |
| LLM (cheap models, caching, plan limits) | ~$10–30 (usage par) |
| DataForSEO (keywords + SERP, cached aggressively) | ~$15–40 (customers badhne par scale) |
| Stripe | $0 + per-transaction fee |
| Domain + email | ~$2–3 |
| **Total start** | **~$35–80/mo** |

Revenue se pehle sab se bara variable cost keyword/SERP data hai — is liye caching + plan limits architecture mein day-1 se hain.

---

## 10. Build Phases

| Phase | Scope | Maqsad |
|---|---|---|
| P1 | Auth, tenancy, billing, dashboard shell, site connect (GSC) | Foundation — login se paid customer tak ka rasta |
| P2 | Crawler + audit + issues + health score | Pehla wow: "meri site mein ye problems hain" |
| P3 | Keywords (research + grouping) + rank tracker | Core SEO loop complete |
| P4 | Content engine + GEO formatting + on-page optimizer | Differentiation shuru |
| P5 | Backlinks + GEO tracker + reports + notifications | Poora loop band |
| P6 | Hardening: security audit, onboarding polish, docs, launch | Bechne ke laayak |

Har phase ke end par testable product — "sab kuch ek saath" nahi.

---

## 11. Open Questions (discussion mein final karenge)

1. **Target customer kaun?** ✅ DECIDED (Oct 10, 2026): Small businesses directly (primary). Agencies baad mein — alag phase/plan mein. Iska matlab: product language non-technical, onboarding super simple, pricing SMB-friendly.
2. **Pricing tiers?** ✅ DECIDED (Oct 10, 2026): Starter **$29/mo** (1 site), Growth **$79/mo** (3 sites), Pro **$149/mo** (10 sites). Wajah: hamari cost ~$2–5/site/mo → ~90% margin; Ahrefs/SEMrush $99+ se saste; SMB-friendly. Stripe products isi amounts par banane hain (STRIPE_PRICE_STARTER/GROWTH/PRO).
3. **CMS publishing?** WordPress/Webflow mein direct publish, ya copy-paste? (Direct publish = zyada kaam, zyada value.)
4. **Keyword data provider final?** ✅ DECIDED (Oct 10, 2026, Steve's call): DataForSEO pay-as-you-go MVP mein — caching + weekly checks + plan limits ke saath. Wajah: keyword volume/difficulty aur rank tracking ke baghair product adhura lagega; pay-as-you-go hai to cost customers ke saath scale hogi, pehle se nahi.
5. **White-label?** Agency plan mein apni branding — Phase 1 mein ya baad mein?
6. **Pehla test user kaun?** ✅ beyonixsolutions.com khud (dogfooding) — website SEO wale parallel track ke saath.
---

## 12. MVP Scope (LOCKED — Oct 10, 2026)

1. Auth + multi-tenancy + Stripe billing + dashboard shell
2. Site connect: domain verify + Google Search Console OAuth + **GA4 connect (implemented Oct 10, 2026: property picker + 28-day traffic overview)**
3. Self-built crawler → technical audit + health score + plain-language fixes
4. Keyword research: GSC queries (free) + DataForSEO volume/difficulty (cached)
5. Rank tracker: weekly SERP checks (DataForSEO, cached, plan-based frequency)
6. AI content engine: SEO+GEO drafts (direct-answer opening, FAQ, schema suggestions), human approve
7. On-page optimizer: meta/title/internal-link/schema suggestions per page
8. GEO / AI-visibility tracker: ChatGPT/Perplexity mention checks + GEO score
9. Weekly plain-language reports + email/Telegram notifications
10. Backlinks v1: GSC links API (free) — new/lost tracking; DataForSEO backlinks v2 mein. **Audit correction (Oct 10, 2026):** GSC has NO links API — v1 data source is the GSC UI CSV export (paste/upload in Backlinks tab) + lost/new detection on stored data.

**Deferred to v2:** CMS direct publish (v1 = copy-paste ready HTML/markdown export), white-label, agency multi-client workspaces, competitor domain overview / keyword gap, PDF reports, site-wide internal-link finder, anchor-text analysis, broken-backlink discovery, disavow/toxic workflow, content decay detection, native AI-platform citation APIs.

**Audit hardening (Oct 10, 2026):** SSRF-safe crawler fetches (private-IP/DNS rebinding blocked), production fail-fast on missing JWT/encryption secrets, `verify_token` + encrypted Google token never leave the API, logout revokes all sessions (token_version), OAuth state TTL sweep, auth rate limiting, generic 500s in prod, ai_words enforced at every spend point, monthly DataForSEO spend caps (`serp_checks`, `keyword_metrics`, `crawl_pages`) with 402 upgrade path, real organic keyword difficulty (bulk_keyword_difficulty, not Ads competition index), location-configurable rank tracking (default US 2840), GEO checks labeled as simulated estimates in the UI.

**Hamari costing (build/test phase):** VPS ~$6–8 + DataForSEO ~$5–15 + LLM ~$5–15 + domain/email ~$2–3 = **~$20–40/mo**

---

## 13. Wave 3 additions (Oct 11, 2026 — QA/Release Lead)

- **Observability**: `GET /metrics` (Prometheus text: HTTP histogram, job
  outcomes, live queue depth, provider spend, dead letters) and `GET /status`
  (JSON: db/redis health, queues, spend, hook flags) registered in
  `backend/src/index.ts` via `routes/metrics.ts`; request ids propagate
  API→error bodies and pino logs (worker logs remain unstructured —
  documented gap). Frontend `/status` page renders the same data.
- **Ops**: `docker-compose.prod.yml` (Caddy TLS, healthchecks, resource
  limits, log rotation, backup sidecar, zero-downtime notes in
  `RUNBOOK.md`); `RUNBOOK.md` (start/stop, migrations, backups/restore, key
  rotation, incidents, CI↔local command map); `.github/workflows/ci.yml`
  (lint, tsc, tests+PG/Redis services, frontend build, migration dry-run,
  npm audit, gitleaks, E2E) + `.gitleaks.toml`.
- **Dev quality**: `backend/scripts/seed.ts` (idempotent demo data,
  `npm run seed`), root `Makefile` (`make dev` one-command bootstrap).
- **Test pyramid**: `integration-stripe` project populated with 11 signed
  webhook tests against the REAL Stripe provider path (BUG-QA-W2-3);
  `tests/wave3/` observability tests; `tests/load/hot-reads.load.mjs`
  (Node load baseline); Playwright E2E attempted (see
  `docs/qa/wave3-results.md`).
- **Docs**: `docs/methodology.md` (score/GEO honesty), `docs/observability.md`,
  `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`; README rewritten to the
  real product; `.env.example` complete and proven against `config.ts`.

Correction to §12: the "Deferred to v2" list is **superseded** — the master
prompt program (Oct 11, 2026) brought CMS publish, white-label, agency
workspaces, competitor analysis, PDF reports, disavow/toxic workflow and
content workflow into the product (F-02..F-08, F-13, F-14, W-* in progress).
