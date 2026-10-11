# Methodology — how scores and simulated data are computed (Wave 3, Q-04)

This document exists so nobody — customer, reviewer or future maintainer —
mistakes a heuristic for a ground truth. Every formula below was read from
the code on 2026-10-11 (file:line references); if the code changes, update
this doc in the same commit.

## 1. Audit health score (0–100)

Source: `backend/src/services/auditRules.ts` → `scoreFor()`.

- The crawler fetches the site (same-domain BFS, robots.txt respected,
  per-host politeness, safeFetch SSRF guarding) and `analyzePage()` extracts
  page facts.
- A fixed rule set (~30 rules, `AUDIT_RULES`) checks each page: missing meta
  description, missing alt text, broken links, H1 issues, HTTPS, page size,
  etc. Each fired rule has a severity: `error` | `warning` | `info`.
- Score = `100 - min(90, Σ weights)`, floored at 0, where
  `error=10, warning=4, info=1`.
- **Honesty note:** the score is a heuristic weighting of our own rule set —
  it is NOT a Google ranking signal and does not predict rank changes. The
  cap of 90 means a completely broken site scores 10, never 0.

## 2. Keyword difficulty & priority

Source: `backend/src/services/keywordService.ts` → `priorityScore()`;
`backend/src/providers/dataforseo.ts`.

- Real DataForSEO: difficulty comes from the **Labs
  `bulk_keyword_difficulty`** endpoint = organic keyword difficulty 0–100.
  The Ads `competition_index` (advertiser competition) is deliberately NOT
  used. If the difficulty call fails, difficulty is stored as `null` —
  never a fabricated number.
- Mock DataForSEO: deterministic seeded pseudo-random values (same keyword
  → same numbers). Clearly a mock; labeled `dataSource: 'mock'` on research
  and rank responses.
- Priority score (1–100) = `log10(volume+1)*22 - difficulty*0.6 + 40`
  (nulls → volume 100, difficulty 50). A sorting heuristic for "work on
  this first", not a forecast.

## 3. Rank tracking & visibility share

Source: `backend/src/services/rankMetrics.ts`.

- `positionVisibility()`: fixed decaying curve (1→100, 2→60, 3→40, ≤5→25,
  ≤10→12, ≤20→5, ≤50→2, else 1; not-in-top-100 → 0). Documented in the code
  as "approximation, not a CTR model".
- `siteVisibilityShare()`: mean of per-keyword visibility points (0–100).
  These describe *our tracked keyword set*, not total organic traffic share.
- SERP snapshots are stored per check; duplicate checks for the same
  keyword/location/tenant share a 7-day cache with cost accounting.

## 4. GEO / AI-visibility (SIMULATED — read this first)

Source: `backend/src/services/geoService.ts`.

- **No public API exposes what ChatGPT/Perplexity/Gemini/Claude actually
  answer.** Every GEO check is our own LLM simulating the platform's answer
  to a prompt, then scanning for brand mentions. Every row is stored and
  returned with `simulated: true`; API responses and the UI label them
  "simulated estimate — directional only".
- `detectMention()`: brand = first label of the domain (or full domain),
  case-insensitive substring match. Naive by design (no disambiguation).
- `analyzeSentiment()`: naive positive/negative word-list count — not a
  sentiment model.
- GEO score (0–100): % of simulated answers mentioning the brand in the last
  30 days (`geoScore()`). Share-of-voice compares the same mention-rate
  across the site + tracked competitors (`shareOfVoice()`).

## 5. PageSpeed / Core Web Vitals

Source: `backend/src/services/pagespeed.ts`.

- Real data from Google PageSpeed Insights (LCP/CLS/INP + Lighthouse
  performance score), cached 7 days, guarded by a daily quota
  (`PAGESPEED_DAILY_QUOTA`, default 25). No key needed at current volumes.
  Best-effort: quota exhaustion or API failure never fails an audit.

## 6. What the mocks are

| Source | Mock behavior (no keys configured) |
|---|---|
| Stripe | In-memory-feeling mock with local confirm URL; full subscribe flow testable. **Disabled in production** (503 `BILLING_NOT_CONFIGURED`). |
| Google/GSC/GA4 | Sample queries, backlinks, GA4 properties/traffic — clearly sample data |
| DataForSEO | Deterministic seeded volume/difficulty/SERP (same input → same output), labeled `dataSource: 'mock'` |
| LLM | Structured template drafts (never presented as model output) |
| GEO engines | Simulated answers (see §4) — labeled everywhere |
| Email/Telegram | Logged to console, never sent |

## 7. What we never claim

- Ranking guarantees or predicted rank changes (no model for this exists).
- Real AI-platform citations (see §4).
- CTR/traffic forecasts (visibility share is not a CTR model).
- Exact keyword volumes (third-party estimates, cached 30d).
