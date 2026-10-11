# AUDIT_RESULT.md — Hostile Audit Record: Wave-4 Final Gate (Passes #1–#12)

**Repo:** `~/workspace/beyonix-seo-tool/` · **Branch:** `main`
**Audit window:** 2026-10-11 ~17:50 PKT → 2026-10-12 ~00:45 PKT
**Method:** 12 passes of fresh, independent hostile auditors (read-only), adversarial re-verification of prior-pass fixes each round, fixes with regression tests before the next pass.
**Clean-pass criterion (program §9):** a pass is CLEAN when it reports **zero new HIGH or MEDIUM findings**. The Final Gate requires **two consecutive CLEAN passes**.
**Result: PASS #11 and PASS #12 were both CLEAN — the Final Gate criterion is met.**
**Raw auditor reports:** `.audit-pass{1..12}-*.md` in this directory (51 reports).
**Note:** `.audit-pass12-l2.md` ends mid-sentence in the repo (report-file truncation); its two findings are reconstructed from the PROGRESS.md narrative in §3.

---

## 1. Summary table — one row per pass

| Pass | Auditors (scope) | Verdict | New HIGH | New MED | New LOW | Dups noted | Headline findings fixed |
|---|---|---|---|---|---|---|---|
| #1 | A1 routes/services · A2 backend core · A3 frontend/docs/secrets | NOT CLEAN | 5 | 14¹ | 19 | 3 (folded into 14¹) | Audit orphan-race → partial unique index (041); `requireRoleOrScope` on ~48 mutating routes; BYOK fail-closed (no provider guessing); `dist/prompts` in prod image; impersonation via HttpOnly `Set-Cookie`; mock `dataSource` badges (rankings/keywords); `.env.example` completion; safeFetch size caps; error envelope 400/`ok:false`/`requestId`; soft-delete excluded from plan counts; Slack via safeFetch; checkout server-side trial length; mock Google fail-closed; JWT-in-body removed |
| #2 | B1 routes/services · B2 backend core · B3 frontend/docs/secrets | NOT CLEAN | 1 | 9 | 21 (incl. 2 fix-regressions²) | 0 | Dockerfile: `npm ci` before build (tsc present) + prompts smoke test; API-key `userId` root fix (`apikey:<uuid>` no longer hits UUID columns); `requireScope(<res>:read)` on ~20 read routes; `/billing/portal` gated `owner/admin`+`billing:write`; refresh routes honest dedupe (`queued:false, deduplicated:true`); 041 orphan-cleanup UPDATE ordered before unique index; atomic `commitUsage` single-statement CTE; fairness per-slot TTL + reaping; provider fetch timeouts; rotation script legacy-`enc:` handling; mock GEO report label; stale invite-accept comment; honest cookie banner |
| #3 | C1 routes/services · C2 backend core · C3 frontend · C4 docs/secrets/deps · C5 billing/metering | NOT CLEAN | 4 | 20 | 33¹ | 2 | `cancelSubscription` on account delete + GDPR erase (C1-H1/H-2) + credit tombstones; coupon `max_redemptions` atomic reserve→redeem→release under row lock; backup sidecar `DATABASE_URL` fix; GSC/GA4 `auth-url` role gates; content generation time-windowed dedupe; `commitUsage` `LEAST` clamp; `crawl_pages` reserve→commit; invoice `amount_paid` (not `$0`); provider cost pricing (cents cap live); site restore plan-limit check; reaper conditional claim; BYOK undecryptable → 502 |
| #4 | D1 routes/services · D2 backend core · D3 frontend · D4 docs/secrets/deps · D5 billing/metering | NOT CLEAN | 5 | 10 | 32 | 0 | **Server-side 14-day trial gate** (product decision: free-Starter-for-all closed); checkout_sessions claim table (050); `invoice.paid` grace-expiry keeps `past_due` (recovery matches); retry-kill regression fixed (attempt-aware failure handling); suspend pauses Stripe billing; logout revokes only current session; soft-delete re-add via partial unique index; backup scripts POSIX-sh; `seedFromGsc` double-decrypt; marketing trial copy corrected to truth |
| #5 | E1 routes/services · E2 backend core · E3 frontend · E4 billing/metering · E5 docs/deps | NOT CLEAN | 3 | 8 | 16 | 2 | On-page analyzer wired into trial gate (+doc heuristic fixed); scheduler spend filter: billing liveness (`enqueueForVerifiedSites` + rank-checks); `BILLABLE_SUBSCRIPTION_STATUSES` drops `incomplete` (route gate); providerGuard rewritten to xact-scoped advisory-lock reserve (E2-M-1, empirically proven); crashed-webhook-event reprocessing (E4-M-2); canceled-row resurrection blocked (E4-M-3); checkout ignores admin-override rows (E4-M-4); `billingPauseFailed` surfaced; ErrorBanner 402→subscribe path + trial countdown + read-only notice (E3-MED-1); postcss npm `overrides` (E5-M-1); `SIGNUP_TRIAL_DAYS` documented |
| #6 | F1 routes/services · F2 backend core · F3 frontend · F4 docs/deps | NOT CLEAN | 0 | 2³ | 12 | 11 | `'incomplete'` removed from both scheduler `IN (...)` lists (single spend-authorization definition); `coupon_redemptions(event_id)` idempotent guard (046); admin override 409 `LIVE_STRIPE_SUBSCRIPTION` on live subs; `started_at` lease reverted → per-handler event-id guards (047→048, `tenant_credits.webhook_event_id` UNIQUE); ErrorBanner labels (`noPlan`); providerGuard `_q` honored; `requireSubscription` doc corrected; DEPLOY migration notes (044–048) |
| #7 | G1 routes/services · G2 backend core · G3 frontend · G4 docs/secrets/deps · G5 billing/metering | NOT CLEAN | 1 | 3 | 5 | 7 | **Next 14.2.35 → 15.5.27 / React 18 → 19.3.0** (CVE-2026-23869 remote DoS, CVSS 7.5 — no 14.x backport) + Caddy `Next-Action` abort rule; `checkout.session.completed` fail-closed `incomplete` for unexpanded string ids (G5-M#1); `invoice.paid` recovery restores plan + `recomputeReadOnly` (G5-M#2); refund delta credit (G5-L#1); lifecycle-email `(event_id,type)` dedupe + migration 049 (G1-L-1); account-security UI: 2FA enrollment/management, password change, forgot/reset flow (G3-M-1); canceled-tenant resubscribe CTA (G3-L-1); DEPLOY 046–049; D1-M-4 recorded as known limitation |
| #8 | H1 routes/services · H2 backend core · H3 frontend · H4 docs/deps · H5 billing/metering | NOT CLEAN | 1 | 0 | 7⁴ | 1 | H5-H#1: status-less checkout write is order-safe — live statuses protected by CASE guard, watermark not advanced by status-less writes; refund delta in explicit transaction (tenant row lock); dunning exactly-once-per-episode (grace minting branch only); email claim-first atomic dedupe; signup 12-char hint; `encodeURIComponent` on download URL builders; postcss devDep aligned; SECURITY.md CVE entries. Regression file: `backend/tests/wave4/w4-pass8-billing-fixes.test.ts` (7 tests) |
| #9 | I1 routes/services · I2 backend core · I3 frontend · I4 docs/secrets/deps · I5 billing/metering | NOT CLEAN | 0 | 1 | 10⁵ | 0 | I5-M#1: `customer.subscription.updated` mirrors consumed-grace (no re-mint/re-dun after consumption); I1-L-1: atomic grace mint (conditional UPDATE, exactly one minter); I1-L-2: `episodeDunningSent` at-least-once-per-episode; I1-L-3: `checkout_sessions` claim table + migration 050 (double-checkout race closed); I2-L-1: reportProcessor loser silent (winner-only notify); I2-L-2: atomic PageSpeed quota claim; I5-L#1: `invSubId` match on revival; I4 docs (D1-M-4 in RELEASE_NOTES, verification table, REDISCLI_AUTH); I3-L-1: `pdfUrl`/`htmlUrl` encoded. Regression file: `w4-pass9-fixes.test.ts` |
| #10 | J1 routes/services · J2 backend core · J3 frontend · J4 docs/secrets/deps · J5 billing/metering | NOT CLEAN | 0 | 1 | 11 | 0 | J3-M#1: `?success=1` notice gated on fetched subscription (incomplete → amber portal CTA); J5-LOW-1: `past_due` revival requires `amount_paid > 0`; J5-LOW-2: coupon reservation released on same-URL idempotent return; J1-LOW-1: status-aware claim steal (creating>10m / open>25h⁶, never live-open); J2-LOW-2: claim release scoped by completing session id; J1-LOW-2/J2-LOW-4: `recentDunningSent` 15-min guard; J2-LOW-3: `enqueueDeduped` 60s claim + extend; J4 docs (050 comment, DEPLOY §7, RUNBOOK 409 row). **Deferred (documented known limitations): J1-LOW-3, J1-LOW-4, J2-LOW-1.** Regression file: `w4-pass10-fixes.test.ts` (6 tests) |
| #11 | K1 routes/services · K2 backend core · K3 frontend · K4 docs/secrets/deps · K5 billing/metering | **CLEAN** | 0 | 0 | 11 | 0 | All 11 LOWs fixed: public `openapi.json` no longer enumerates `/admin/*`; `enqueueDeduped` extend via Lua compare-and-exists; scheduler per-site try/catch; `checkout.session.completed` falls back to deleting `'creating'`-NULL claims; ErrorBanner `incomplete` cause-branch; reset-password `?token=` scrubbed; cancel copy conditional for `incomplete`; RUNBOOK 409 row corrected; `canceled`-revival requires `amount_paid > 0`; refund email formats cents; `open` steal threshold 24h (was 25h). Regression file: `w4-pass11-fixes.test.ts` (4 tests). Commit: `566065e` |
| #12 | L1 routes/services · L2 backend core · L3 frontend · L4 docs/secrets/deps · L5 billing/metering | **CLEAN** | 0 | 0 | 6⁷ | 0 | All 6 LOWs fixed: rank-checks loop per-site try/catch (the one loop K2-2 missed); K2-3 fallback DELETE pinned to claims predating the completing session (`created_at < data.created`); ErrorBanner headline overridable for `incomplete`; grace-consumed `past_due` "Payment failed." copy; generic read-only "Subscribe" alert suppressed when specific alerts render. **→ Final Gate criterion satisfied (two consecutive clean passes).** |

**Footnotes:**
1. Pass#1: 17 medium filed, 3 pairs merged → 14 unique. Pass#3: auditors filed 38 LOWs; Audit Lead consolidated unique count = 33.
2. Pass#2 B1-R1/R2 are regressions in the pass#1 fixes (wrong/incomplete), counted as LOW.
3. Pass#6 F1-M-1 and F2-M-1 are the same finding reported by two auditors (scheduler `incomplete` vs trial gate).
4. Pass#8: 8 LOWs reported; H1-L-1 is a duplicate of H2-L-1 (audited a stale tree) → 7 unique.
5. Pass#9: 10 LOWs filed by auditors; the LA narrative records "1 MED + 7 LOWs" triaged — 3 were folded as duplicate/observation during triage.
6. Pass#10 set the `open` steal threshold to 25h (J1-LOW-1); pass#11 K5-LOW-3 tightened it to 24h.
7. Pass#12: 6 LOW reports; L1-1 and L2-2 are the same rank-checks loop (L1 audited the pre-fix HEAD) → 5 unique findings.

---

## 2. Every finding ever filed

Conventions: `Fix` = the commit/branch that fixed it (from PROGRESS.md and the auditor reports); `Test` = regression test file where a report names one; `—` = none named in reports. Fixes marked `merged` were applied to `main` and re-verified by a later pass's adversarial re-check. DUP = duplicate of an earlier finding (not re-fixed).

### Pass #1 — auditors A1/A2/A3 (2026-10-11; 5H/14M unique/19L)

Fixes: backend branch `agent/wave4-fix-backend` + frontend branch `agent/wave4-fix-frontend` (frontend portion `cd667ad`); merged to `main`; all adversarially re-verified as holding by pass#2 auditors (B1/B2/B3).

| ID | Sev | file:line | Finding | Fix | Test |
|---|---|---|---|---|---|
| A1-H1 | HIGH | `backend/src/routes/audit.ts:68-105` | Audit double-submit / enqueue-failure leaves permanent orphan `queued` row → all future audits 409 forever | migration 041: partial unique index `audits_one_active_per_site` + transactional check + mark `failed` on enqueue failure; per-audit jobId | — |
| A1-H2 | HIGH | `backend/src/routes/sites.ts:176` + ~48 mutating routes | Team roles unenforced: `requireScope` no-ops for user sessions, zero `requireRole` on product mutations — any viewer could delete sites, publish, trigger crawls | `requireRoleOrScope(['owner','admin','editor'], scope)` applied to all mutating domain routes | — |
| A2-H1 | HIGH | `backend/src/providers/llm.ts:93-99` | Tenant BYOK LLM key sent to the WRONG provider (credential disclosure to Google/OpenAI query string) | fail-closed: never guess provider for a BYOK key; require explicit tenant provider | — |
| A2-H1b | HIGH | `backend/src/middleware/access.ts` | DUP of A1-H2 (same root cause) | see A1-H2 | — |
| A2-H2 | HIGH | `backend/Dockerfile:9-14` + `src/services/prompt.ts` | Prod image never ships `src/prompts/*.txt` → every LLM feature ENOENT in prod while tests stay green | `COPY src/prompts ./dist/prompts` after build + build-smoke test | — |
| A3-H1 | HIGH | `frontend/app/admin/page.tsx:130` | Admin impersonation writes session JWT via `document.cookie` (JS-readable, no Secure) — XSS could steal the 5-min tenant session | impersonation issues session via HttpOnly `Set-Cookie` (`app/api/admin/impersonate/route.ts`) | — |
| A1-M1 | MED | `backend/src/routes/*` (plan-limit checks) | Plan-limit enforcement check-then-act everywhere; atomic `reserveUsage` has zero production callers | choke points wired through `reserveUsage` + `commitUsage`/`cancelUsage` | — |
| A1-M2 | MED | `backend/src/middleware/csrf.ts:44-61` | CSRF guard 403s legit API-key browser clients carrying a session cookie (`x-api-key` not exempted) | `x-api-key` treated as non-ambient credential (exempt) | — |
| A1-M3 | MED | `backend/src/metering.ts:131` | `checkLimit('sites')` counts soft-deleted sites → deleted sites burn plan quota for 30 days | `AND deleted_at IS NULL` in site counts | — |
| A1-M4 | MED | `backend/src/services/notifications.ts:77-84` | Slack dispatch validates webhook URL then uses raw `fetch()` — DNS-rebinding TOCTOU | dispatch via `safeFetch` | — |
| A1-M5 | MED | `backend/src/routes/admin.ts:139-152` | Admin plan override leaves tenant stuck `read_only` with `subscriptions` row `canceled` | override recomputes `read_only` and syncs the subscriptions row | — |
| A1-M6 | MED | `backend/src/routes/billing.ts:28` | Checkout accepts client-controlled `trialDays` up to 90 | `trialDays` removed from client schema; set server-side | — |
| A1-M7 | MED | `backend/src/routes/admin.ts:100-116` | Admin tenant-detail returns full row incl. `llm_api_key_enc` ciphertext | explicit column select; never return the encrypted key | — |
| A2-M1 | MED | `backend/src/middleware/access.ts:105-118` | DUP of A1-H2/M-pattern: `requireScope` passes team sessions freely — viewers can mutate (reported at MED) | see A1-H2 | — |
| A2-M2 | MED | `backend/src/metering.ts:104-107` | DUP of A1-M3 (soft-deleted sites counted, incl. `reserveUsage` path) | see A1-M3 | — |
| A2-M3 | MED | `backend/src/metering.ts:225-290` | DUP of A1-M1 (atomic reserve-then-commit dead in production) | see A1-M1 | — |
| A2-M4 | MED | `backend/src/scheduler.ts:25-30` | Leader-election 30s TTL can expire mid-tick → duplicate digests + webhook deliveries (no atomic claim) | leader lock heartbeat + atomic claim-then-work in both consumers | — |
| A2-M5 | MED | `backend/src/queues.ts:140-147` | `incr`-then-`expire` race can permanently 429 a tenant/API key (key with no TTL) | atomic Lua `incrWithTtl` + `redisKeyPrefix()` | — |
| A2-M6 | MED | `backend/src/worker.ts:70-81` | Fairness `moveToDelayed` + normal return likely double-executes heavy jobs | throw dedicated non-retryable `DelayedError` after `moveToDelayed` | — |
| A2-M7 | MED | `backend/src/services/geoService.ts:98` | GEO check prompt injects raw user query — no `delimitUntrusted` | wrap query in `delimitUntrusted()` | — |
| A3-M1 | MED | `frontend/components/tabs/RankingsTab.tsx` | Rankings UI shows mock SERP data with no mock label (backend returns `dataSource`, frontend drops it) | thread `dataSource`, render mock badge | — |
| A3-M2 | MED | `frontend/components/tabs/KeywordsTab.tsx` | Keyword research volume/difficulty mock not labeled (gap panel labels it — inconsistent) | surface `dataSource`, badge mock results | — |
| A3-M3 | MED | `.env.example` | Missing real vars: `NEXT_PUBLIC_API_URL`, `API_INTERNAL_URL`, `APP_HOST`/`API_HOST`/`APP_TLS_EMAIL`, `STRIPE_PRICE_*_ANNUAL`, `BSEO_REDIS_PREFIX`, `DB_STATEMENT_TIMEOUT_MS`, `LLM_TENANT_DEFAULT_CAP_WORDS`, `SEED_DEMO`, `MOCK_GOOGLE_*` | all added to `.env.example` | — |
| A1-L1 | LOW | `backend/src/routes/backlinks.ts:151-158` | Backlink CSV upload does up to 5000 sequential single-row INSERTs in the request handler | batched multi-row INSERT | — |
| A1-L2 | LOW | `backend/src/routes/metrics.ts:57` | `GET /metrics` unauthenticated, exposes aggregate provider spend | documented opt-in `METRICS_BASIC_AUTH` (accepted as designed) | — |
| A1-L3 | LOW | `CONTRACTS.md:239` | Docs vs code: error envelope shape (`ok:false` wrapper) | `CONTRACTS.md` updated to pinned `{ ok:false, error:{...} }` | `tests/n-a1-2.test.ts` |
| A1-L4 | LOW | `backend/src/metering.ts:240` etc. | Dead code: `reserveUsage`/`commitUsage`/`cancelUsage`, `paged`, `GeoEngine`, `needsRankCheck` | wired into production (or removed) | — |
| A1-L5 | LOW | `backend/src/routes/account.ts:311-312` | `u(req)` (`"apikey:<id>"`) into UUID columns → latent 500 | call sites switched to `actorUserId(req)` | — |
| A1-L6 | LOW | `backend/src/routes/settings.ts:33` | `PATCH /settings` accepts empty-string `llm_api_key` (BYOK "configured" with nothing) | `minLength: 1` / treat `''` as clear | — |
| A2-L1 | LOW | `backend/src/middleware/auth.ts:190` etc. | `jwt.verify` without `algorithms` whitelist (3 sites) | pin `{ algorithms: ['HS256'] }` | — |
| A2-L2 | LOW | `migrations/040_wave3.sql:27` etc. | Duplicate indexes (040 vs 001; `api_keys_hash_idx` vs UNIQUE) | drop duplicates in a new migration | — |
| A2-L3 | LOW | `middleware/idempotency.ts:131` etc. | Dead exports (`storeIdempotentResponse`, `currentKid`) | removed/documented | — |
| A2-L4 | LOW | `backend/src/middleware/csrf.ts:66-72` | DUP of A1-M2 (CSRF guard treats `x-api-key` as cookie session) | see A1-M2 | — |
| A2-L5 | LOW | `backend/src/providers/stripe.ts:78` | Local coupon codes passed straight through as Stripe coupon IDs (mock/real split) | map local codes to Stripe coupon IDs | — |
| A2-L6 | LOW | `backend/src/services/retention.ts:37-44` | Committed `usage_reservations` never purged (unbounded growth) | align with 13-month `usage_events` window | — |
| A2-L7 | LOW | `backend/src/services/fairness.ts:25-38` | Fairness slot TTL (900s) not heartbeated by the holder | heartbeat the slot / TTL ≥ max job timeout | — |
| A2-L8 | LOW | `backend/migrations/` | Migration numbering gaps 008/009/031–039 (informational) | none needed (documented) | — |
| A3-L1 | LOW | `frontend/app/dashboard/settings/page.tsx:75,87` | Settings inputs lack programmatic label association | `htmlFor`/`id` pairing | — |
| A3-L2 | LOW | `backend/tests/fixtures/ssrf/key.pem` | Test-fixture private key committed (synthetic, test-only) | none required (informational) | — |
| A3-L3 | LOW | `frontend/app/dashboard/team/page.tsx:90-96` | Invite debug token can render in UI on prod-without-SMTP | gate `inviteDebugFields` on non-production + loud UI warning | — |
| A3-L4 | LOW | `frontend/app/dashboard/team/accept/page.tsx:31-33` | Invite token held in `sessionStorage` (XSS-exfiltratable) | accepted pattern (noted) | — |
| A3-L5 | LOW | `backend/package.json` | Dependency review limitation (`npm audit` blocked) + no `engines` field | run in CI; add `engines` | — |

### Pass #2 — auditors B1/B2/B3 (2026-10-11; 1H/9M/21L)

Fixes: `d61068a` (backend) + `0c92292` (frontend), merged to `main`; LA post-merge verification: 711 passed / 9 skipped / 0 failed, tsc clean, frontend build green. Pass#1 fixes adversarially re-verified as holding by all three B auditors (not re-reported).

| ID | Sev | file:line | Finding | Fix | Test |
|---|---|---|---|---|---|
| B2-H-1 | HIGH | `backend/Dockerfile:10,14` | Production image cannot be built: `npm ci --omit=dev` removes `typescript`, so `npm run build` fails with `tsc: not found` | `npm ci` (full) → build → `npm prune --omit=dev` | — |
| B1-1 | MED | `backend/src/routes/competitors.ts`, `ga4.ts`, `gsc.ts`, `sites.ts`, `settings.ts`, `billing.ts`, `account.ts` | API-key scope model not enforced on ~20 GET routes (any key can read any resource's data within the tenant) | `requireScope('<resource>:read')` on each read route | — |
| B1-2 | MED | `backend/src/routes/billing.ts:295` | `POST /billing/portal` has no auth gate — any API key can mint a Stripe portal session (full billing management) | `requireRoleOrScope(['owner','admin'], 'billing:write')`; `billing:write` scope added | — |
| B1-3 | MED | `backend/src/routes/ranks.ts:402` etc. | Manual refresh routes lie: BullMQ jobId dedupe makes repeat clicks silent no-ops while API returns `{ok:true, queued:true}` | `enqueueDeduped` + honest `{queued:false, deduplicated:true}` | — |
| B2-M-1 | MED | `backend/migrations/041_wave4_pass1.sql:11-23` | Orphan-cleanup UPDATE runs AFTER the unique index it was meant to enable → migration can never apply on DBs with pre-fix orphans | orphan-cleanup UPDATE moved above `CREATE UNIQUE INDEX` | — |
| B2-M-2 | MED | `backend/src/metering.ts` | `commitUsage`: reservation flip + `usage_events` write not atomic (spend invisible between statements; crash loses evidence) | single-statement CTE | — |
| B2-M-3 | MED | `backend/src/services/fairness.ts` | Crashed worker's heavy slot leaks indefinitely under sustained traffic (TTL refreshed on every acquire) | per-slot keys with individual TTL + reaping | — |
| B2-M-4 | MED | `backend/src/providers/llm.ts`, `dataforseo.ts`, `notify.ts` | Outbound provider `fetch()` calls have no timeouts (hung TLS hangs API routes/workers) | `AbortSignal.timeout(...)` on every outbound call | — |
| B2-M-5 | MED | `backend/scripts/rotate-encryption-keys.ts` | Rotation bricks legacy `enc:` (kid-less) rows (decrypted with new primary → fails) | two-step rotation documented / legacy fallback parameter | — |
| B3-M-1 | MED | `frontend/components/tabs/ReportsTab.tsx:36` | Report highlights present the SIMULATED GEO score as measured fact ("X% of AI answers mentioned your brand") | labeled "AI visibility score (simulated estimate)" | — |
| B1-R1 | LOW | `backend/src/middleware/auth.ts:153` | **Fix-regression of A1-L5:** `userId = "apikey:<uuid>"` still flows into UUID columns → 500 on ~15 user-scoped endpoints | `userId` root fix in `tenantFromApiKey` + `requireHumanSession` on user-account routes | — |
| B1-R2 | LOW | `backend/src/services/contentEngine.ts:30-53` | **Fix-incomplete of S-09:** prompt-injection delimiting missed `content-outline`/`content-draft`/`seo-assets` | wrap all user-controlled template vars in `delimitUntrusted()` | — |
| B1-4 | LOW | `backend/src/services/serpSnapshots.ts:~138` | `getSerpSnapshot` cache-hit path hardcodes `providerIsMock: false` (mock data labeled real) | select `source_provider`, set honestly | — |
| B1-5 | LOW | `backend/src/routes/audit.ts:100-106` | No ongoing reaper for stuck `queued` audits (route check has no age bound) | scheduler sweep marking `queued` >2h as `failed` (B1-5) | — |
| B1-6 | LOW | `backend/src/providers/stripe.ts:14-27` | `planIdFromStripePrice` reverse map omits annual prices | include `_ANNUAL` env vars in reverse map | — |
| B1-7 | LOW | `backend/src/services/keywordService.ts:481-492` | `importKeywords` does up to 1000 sequential single-row INSERTs | batch the upsert | — |
| B1-8 | LOW | `backend/src/routes/audit.ts:19` | `isoWeekKey()` still has the N-A2-2 local/UTC mix | delete local copy, import `isoWeek` | — |
| B1-9 | LOW | `backend/src/services/keywordCache.ts:52` | `getKeywordMetrics` commits full reservation on partial provider results | `actualUnits: fresh.length` | — |
| B1-10 | LOW | `backend/src/routes/billing.ts:196-236` | Checkout holds the tenant row lock across a Stripe network call | create Stripe customer BEFORE `BEGIN`, lock+check+update inside tx | — |
| B2-L-1 | LOW | `backend/src/metering.ts` | `reserveUsage`/`commitUsage` zero units violate `CHECK (units > 0)` → raw 500 | floor at 1 / clean 400 | — |
| B2-L-2 | LOW | `backend/src/providers/captcha.ts` | `CAPTCHA_PROVIDER=test` honored in production (hardcoded pass token) | refuse `'test'` unless test/dev | — |
| B2-L-3 | LOW | `backend/scripts/backup.sh`, `restore.sh` | DB password visible in process table (`pg_dump "$DATABASE_URL"`) | `PGPASSWORD`/`.pgpass` or split `PG*` vars | — |
| B2-L-4 | LOW | `backend/src/errors.ts` | Fastify validation `details` leak schema internals in production | drop/sanitize `details` in prod | — |
| B2-L-5 | LOW | `backend/src/services/llmMetered.ts` | W-03 tenant LLM cap is check-then-act | fold into reservation tx / document advisory | — |
| B2-L-6 | LOW | `backend/src/crypto.ts` | Memoized `KEYS` means key rotation requires restart (undocumented) | print restart reminder in rotate script | — |
| B2-L-7 | LOW | `backend/src/providers/stripe.ts` | `applyPaymentEvent` early returns skip `processed_at` ledger update | set `processed_at` on all exit paths | — |
| B2-L-8 | LOW | `backend/src/middleware/idempotency.ts` | `withIdempotency` wraps only `/billing/checkout` despite general docstring | extend or scope docstring | — |
| B2-L-9 | LOW | `backend/Dockerfile` | No `HEALTHCHECK` | add healthcheck on `/healthz` | — |
| B3-L-1 | LOW | `frontend/app/dashboard/team/accept/page.tsx` | Invite-accept forces unnecessary re-login (stale comment; backend already issues the session cookie — commit `345b563`) | navigate straight to `/dashboard` on accept | — |
| B3-L-2 | LOW | `frontend/components/CookieBanner.tsx` + privacy §3 | Cookie-consent control is theater (no analytics loaded; consent key never read; policy misdescribes) | honest essential-only banner; reword privacy §3 | — |
| B3-L-3 | LOW | `docker-compose.prod.yml:194` | Caddy image not digest-pinned (floating tag on TLS terminator) | pin digest before first deploy (same-pass dup: D4-L-6 filed later — see §4) | — |

### Pass #3 — auditors C1/C2/C3/C4/C5 (2026-10-11; 4H/20M/33L consolidated)

Fixes: `1037c40` = BE-1 `da9c717` (billing) + BE-2 (metering/fairness/scheduler) + FE `00a8d57` (frontend/docs), merged to `main`. Regression tests: `backend/tests/wave4/w4-fix3-be1.test.ts`, `backend/tests/wave4/w4-fix3-be2.test.ts`. Post-merge: 757 passed / 0 failed, tsc clean, frontend build green.

| ID | Sev | file:line | Finding | Fix | Test |
|---|---|---|---|---|---|
| C1-H1 | HIGH | `backend/src/routes/account.ts:290-296` | Deleting a tenant account leaves the live Stripe subscription billing a ghost tenant (Stripe dashboard shows subscription, DB shows nothing) | `cancelSubscription` added to `eraseTenantData` + `deleteAccount`; idempotent; credit tombstones kept; `eraseTenantData` signature extended | `w4-fix3-be1.test.ts:427` |
| C1-H2 | HIGH | `backend/src/routes/admin.ts:176-187` | GDPR erase cancels Stripe only when `subscriptions` row exists; absent row → live Stripe subscription survives erase | eraseTenantData now drives cancel off the Stripe customer, not the DB row | `w4-fix3-be1.test.ts:466` |
| C4-H1 | HIGH | `backend/scripts/backup.sh:1-22`, `restore.sh:1-19` | Backup sidecar dead: no `set -euo pipefail`/`PGPASSWORD`; `restore.sh` passes `"$DATABASE_URL"` as dbname; pg 16/17 client vs 15 server; backups write to ephemeral container FS (no volume) | `DATABASE_URL` split into `PG*` vars; strict mode; `pg_dump` from server image; retention + restore dry-run | `w4-fix3-be1.test.ts` |
| C5-H-1 | HIGH | `backend/src/services/coupons.ts:31-48` | Coupon `max_redemptions` check-then-act across two requests: concurrent checkouts overshoot `max_redemptions` | atomic reserve→redeem→release with `SELECT … FOR UPDATE` on coupon row; expired-coupon guard | `w4-fix3-be1.test.ts:489` |
| C1-M-1 | MED | `backend/src/routes/ga4.ts:52` | `GET /ga4/auth-url` reachable with `viewer` role | `requireRoleOrScope(['owner','admin','editor'], 'integrations:write')` | — |
| C1-M-2 | MED | `backend/src/routes/gsc.ts:45` | `GET /gsc/auth-url` reachable with `viewer` role | same gate as M-1 | — |
| C1-M-3 | MED | `backend/src/services/contentEngine.ts:58-99` | Content generation bypasses concurrency cap via three direct call paths | all generation funnels through time-windowed dedupe (`inFlight`/`cooldown`) | — |
| C1-M-4 | MED | `backend/src/metering.ts` | `commitUsage` computes charge post-hoc from raw LLM words: mock/provider failures cause quota overshoot | `LEAST(raw, reserved)` clamp on both paths | `w4-fix3-be2.test.ts:69-81` |
| C1-M-5 | MED | `backend/src/routes/audit.ts:118-126` | Crawl quota: audit creates pages before checking `crawl_pages` quota → quota can overshoot | reserve→commit pattern at start; release on failure | — |
| C1-M-6 | MED | `backend/src/routes/billing.ts` | Webhook can resurrect canceled subscriptions from stale `invoice.payment_succeeded` events | ignore events older than the recorded cancellation timestamp | — |
| C1-M-7 | MED | `backend/src/routes/sites.ts:216` | `POST /sites/restore` resurrects a site past the plan's site limit | plan-limit check + soft-delete filtered from active count | — |
| C1-M-8 | MED | `backend/src/scheduler.ts` | Crash between Stripe-success and `subscriptions` row insert loses the payment | outbox pattern / reconcile sweep | — |
| C2-M1 | MED | `backend/src/routes/ranks.ts:406-420` | `getSerpSnapshot` check-then-insert (parallel jobs race; UNIQUE 23505 crashes a worker) | transactional `refreshSnapshots` + rank-worker atomic `trySnapshotClaim` | — |
| C2-M2 | MED | `backend/src/routes/ranks.ts:398-404` | `getKeywordMetrics` `committedAt` only advances on full refresh; `actualUnits` inflates usage | commit on any fresh result, `actualUnits = fresh.length` | — |
| C4-M1 | MED | `backend/scripts/backup.sh:44-46` | Backup retention deletes every file whose mtime < 30 days in a shared dir | retention scoped to backup filename pattern | — |
| C4-M2 | MED | `backend/src/services/geoService.ts:112-140` | Mock GEO provider returns fake AI scores labeled as measured (no visible mock tag) | response marks `dataSource: 'mock'`; frontend displays it | — |
| C4-M3 | MED | `docker-compose.prod.yml:62` | Database password interpolates from `.env` at compose parse time → can bake into image labels/logs | documented; secret via file/env-file, not interpolation | — |
| C4-M4 | MED | `backend/src/routes/gsc.ts:34-36` | Demo seed can silently overwrite real GSC OAuth state | refuse seeding when a connection exists; explicit opt-in flag | — |
| C5-M-1 | MED | `backend/src/services/invoices.ts:19-31` | `invoice.payment_succeeded` applies `amount_paid = $0` (grandfathered/zero coupons): tenant unlocked without payment | apply `amount_paid` from Stripe | `w4-fix3-be1.test.ts` |
| C5-M-2 | MED | `backend/src/services/coupons.ts:34-46` | Coupon max check happens AFTER `commitUsage` — concurrent overshoot under row lock | ordering fixed: atomic reserve before commit | — |
| C5-M-3 | MED | `backend/src/services/seedFromGsc.ts:47-60` | `seedFromGsc` decrypts the GSC token inside a row-locked loop (long tx) | decrypt-once-outside transaction | — |
| C5-M-4 | MED | — | DUP of C1-M-4 (`commitUsage` clamp) — one fix | see C1-M-4 | — |
| C5-M-5 | MED | `backend/src/routes/billing.ts:190-236` | Checkout flow holds tenant lock across Stripe network call (slow-loris DB lock) | Stripe customer created before BEGIN; lock only for check+update | — |
| C5-M-6 | MED | `backend/src/services/providerGuard.ts:12-34` | Provider budget guard: `incrementAndCheck` not atomic (`GET`+`DECR` in a loop) | Lua script, single server round-trip | — |
| C1-L-1 | LOW | `backend/src/routes/ranks.ts:428-431` | `getKeywordMetrics` can `actualUnits > reservedUnits` on cache-partial | clamp `actualUnits <= reservedUnits` | — |
| C1-L-2 | LOW | `backend/src/routes/billing.ts:296-308` | Mock Stripe-mode `confirm` replays double-redeem a coupon (local mock only) | idempotency-keyed confirm path | — |
| C1-L-3 | LOW | `backend/src/routes/sites.ts:187` | Deleting a site leaves its audits orphaned (no cascade note) | cascade-delete site audits | — |
| C1-L-4..L-18 | LOW | `backend/src/routes/*` | Route-level lows: unused imports, stale comments, inconsistent error shapes, missing `read` scopes on informational endpoints, N+1 on team list, `LIMIT` defaults, pagination metadata, response ordering determinism, `HEAD` handlers, `ETag` absence, log noise, redundant JSON parse, `text/csv` charset, `Content-Disposition` quoting, 204-with-body, duplicate route registration guards | branch fixes + doc updates | — |
| C2-L-1 | LOW | `backend/migrations/*` | Several migrations lack `statement_timeout` guards | `SET LOCAL statement_timeout` added | — |
| C2-L-2 | LOW | `backend/src/middleware/*` | `requireRole()` with zero args grants nothing/ambiguous | explicit roles required | — |
| C2-L-3 | LOW | `backend/src/services/serpSnapshots.ts` | `serp()` `www.`-exact match dead code | removed | — |
| C2-L-4 | LOW | `backend/src/middleware/csrf.ts` | DUP of A1-M2 (CSRF `x-api-key` exemption) — keep one record | see A1-M2 | — |
| C2-L-5 | LOW | `backend/src/services/leader.ts` | Leader re-entry overlapping ticks on long jobs | lease check re-entrant guard | — |
| C2-L-6 | LOW | `backend/src/metering.ts` | Per-row date key in usage-events aggregation | week-key normalization | — |
| C3-L-1..L-5 | LOW | `frontend/components/*` | Frontend lows: ARIA labels on icon buttons, focus-visible styles, table `scope` attributes, `alt` text on sparkline images, color-contrast tokens | FE `00a8d57` | — |
| C4-L-1..L-4 | LOW | docs | Doc lows: stale `DEPLOY.md` env table, `README` port mismatch, missing `openapi` for two routes, diagram drift | docs updated | — |
| C5-L-1..L-5 | LOW | billing/metering | Billing lows: invoice memo formatting, coupon list pagination, idempotency key propagation, webhook signature-timing log, plan-name normalization | branch fixes | — |

### Pass #4 — auditors D1–D5 (2026-10-11; 5H/10M/32L)

Fixes: BE-A (trial gate + billing), BE-B (seedFromGsc + rate limiter + backup POSIX), FE-C (frontend/docs) branches + LA cleanup branch (Stripe `pause_collection` on suspend, atomic global reserve, soft-delete re-add partial unique index, batched rescore, crawl TTL scaling) — all merged to `main`. Post-merge: 788 passed / 0 failed; tsc clean; frontend build green. Migration 044 (`trial_ends_at`) + 045 (partial index + `global_provider_guard`).

| ID | Sev | file:line | Finding | Fix | Test |
|---|---|---|---|---|---|
| D1-H-1 | HIGH | `backend/src/routes/onpage.ts:62` | Trial gate bypass: `POST /onpage/analyze` (and `/onpage/suggestions`) let unpaid users run the most expensive single analysis | route wrapped in trial/billing gate (`requireActivePlanOrTrial`) | — |
| D1-H-2 | HIGH | `backend/src/scheduler.ts` | Reaper regression: `refreshFailedJobs` revives `failed` crawl jobs while `auditJobs` keeps its `failed` requeue disabled → asymmetric stuck-job handling | attempt-aware failure handling aligned on both paths | — |
| D4-H-1 | HIGH | `backend/scripts/backup.sh` | Still dead in staging shape: hard-coded container hostnames, `pg_dump` args order, no lockfile | POSIX-sh rewrite, lockfile, env-driven hosts | — |
| D5-H-1 | HIGH | `backend/src/services/billing.ts` | Every signup gets a free Starter with **no payment gate at all** → any bot farm consumes provider spend | **Product decision: server-side 14-day trial** (`trial_ends_at`, enforced by middleware); signup email updated; marketing copy corrected; recorded in `RELEASE_NOTES.md` | — |
| D5-H-2 | HIGH | `backend/src/services/seedFromGsc.ts` | Double-decrypt of the GSC OAuth token (two code paths decrypt the same ciphertext → one corrupts the other under concurrency) | decrypt-once; pass plaintext through the call chain | — |
| D1-M-1 | MED | `backend/src/services/invoices.ts` | Downgrade double-billing: downgrade keeps the old Stripe subscription active alongside the new one | `cancelAtPeriodEnd` on the superseded subscription during downgrade | — |
| D1-M-2 | MED | `backend/src/scheduler.ts` | Scheduler spends provider budget on tenants whose Stripe is `past_due`/`canceled` | scheduler filters to billing-live tenants before spending | — |
| D1-M-3 | MED | `backend/src/services/billing.ts` | `incomplete` treated as billable in scheduler's `IN (...)` | removed from billable list | — |
| D1-M-4 | MED | `backend/src/services/crawl.ts` | Crawl reservation TTL < worst-case crawl duration; `ttlMinutes` hook is dead code → reservations expire mid-crawl | TTL scaling to crawl size; **D1-M-4 remedy recorded as a standing known limitation** (see §4; RELEASE_NOTES limitation #9) | — |
| D2-M-1 | MED | `backend/src/middleware/rateLimit.ts` | Tenant queue rate limiter can hang a request forever (no backpressure timeout) | bounded wait + fail-fast 429 | — |
| D3-M-1 | MED | `frontend/app/dashboard/page.tsx` | Dashboard shows stale plan state after plan change (no revalidation) | revalidate on focus / router refresh | — |
| D3-M-2 | MED | `frontend/components/billing/*` | Billing page hides `past_due` behind a generic banner | explicit past_due recovery CTA | — |
| D4-M-1 | MED | `backend/Dockerfile` | `dist/` copied before `npm ci` in one stage → stale build artifacts | layer ordering fixed | — |
| D4-M-2 | MED | `backend/src/services/audit.ts` | Audit worker writes partial results on crash (no checkpoint) | atomic result write | — |
| D4-M-3 | MED | `docker-compose.prod.yml` | Redis without `requirepass` in one profile | password enforced on all profiles | — |
| D4-M-4 | MED | `backend/src/services/fairness.ts` | Fairness slot starves small tenants under sustained load | slot rotation fairness | — |
| D5-M-1 | MED | `backend/src/services/billing.ts` | Suspend doesn't pause Stripe → suspended tenant keeps being billed | `pause_collection` on suspend | — |
| D5-M-2 | MED | `backend/src/services/billing.ts` | Webhook crash between Stripe event and DB write loses the event (no requeue) | crash-retry reprocessing of unacked events | — |
| D5-M-3 | MED | `backend/src/services/billing.ts` | `invoice.paid` on a downgraded-then-repaid tenant sets the wrong plan | recovery sets plan from the invoice's subscription | — |
| D1-L-1..L-15 | LOW | routes/services | Route lows: `GET /account/export` missing scope, webhook replay window, `If-None-Match` on report GET, `Retry-After` on 429, pagination cursor determinism, `search` length caps, CSV BOM, `filename*` encoding, `X-Request-Id` echo, `traceparent` propagation, structured-log field names, `deprecated` headers on v1 aliases, `OPTIONS` cache headers, trial-days display rounding, plan-name casing | BE-A/BE-B | — |
| D2-L-1..L-3 | LOW | backend core | Core lows: `setInterval` drift in scheduler, jitter on retry backoff, log-level of expected 404s | BE-B | — |
| D3-L-1..L-5 | LOW | frontend | Frontend lows: loading skeletons on settings, `prefers-reduced-motion`, table sticky headers, `inputmode` on numeric fields, `autocomplete` attributes | FE-C | — |
| D4-L-1..L-6 | LOW | docs/deps | D4-L-1..L-4 doc/deps lows (changelog links, SBOM note, license headers, `SECURITY.md` contact); **D4-L-5** `.worktrees/` 2.2GB stale copies (still open, §4); **D4-L-6** `caddy:2-alpine` unpinned (still open, §4) | docs fixed; L-5/L-6 standing | — |
| D5-L-1..L-5 | LOW | billing | Billing lows: proration display, tax-id passthrough, receipt email wording, `cancel_at` vs `cancel_at_period_end` copy, trial-end email timing | BE-A | — |

### Pass #5 — auditors E1–E5 (2026-10-11; 3H/8M/16L)

Fixes: `7696191` (E1+E5: onpage gate, postcss override, `SIGNUP_TRIAL_DAYS` docs, DEPLOY trial section), `23794db` (E4 HIGHs), `bd6fbff` (E2+E4 MEDIUMs), `58bee77` (E3 frontend) — all on `main`. Migrations 044/045 present on main (041–045 verified). Post-merge: 802 passed / 0 failed.

| ID | Sev | file:line | Finding | Fix | Test |
|---|---|---|---|---|---|
| E1-H-1 | HIGH | `backend/src/routes/onpage.ts` | **Fix-incomplete of D1-H-1:** `/onpage/suggestions` and bulk path missed the trial gate | all onpage paths wrapped in the trial gate | `7696191` |
| E4-H-1 | HIGH | `backend/src/scheduler.ts` | Scheduler spend filter bypassed by `rank-checks` path (D1-M-2 fix only covered one queue) | `enqueueForVerifiedSites` + rank-checks both filter to billing-live tenants | `23794db` |
| E4-H-2 | HIGH | `backend/src/services/billing.ts` | `incomplete` checkout bypass: tenant stuck `incomplete` could activate via webhook clobbering | status guard on webhook application | `23794db` |
| E2-M-1 | MED | `backend/src/services/providerGuard.ts` | Provider-guard check-then-act overshoots the per-provider budget (empirical overshoot measured: 140¢ vs 100¢ cap) | rewritten: xact-scoped `pg_advisory_xact_lock` + atomic reserve | `bd6fbff` |
| E3-MED-1 | MED | `frontend/components/ErrorBanner.tsx` | Trial users hitting paywalled routes see a raw 402 with no upgrade path | ErrorBanner: 402 → "Start subscription" CTA + trial countdown + read-only notice | `58bee77` |
| E4-M-1 | MED | `backend/src/services/billing.ts` | `BILLABLE_SUBSCRIPTION_STATUSES` still included `incomplete` in the route gate (never-funded checkout treated as paid) | `incomplete` removed from `BILLABLE_SUBSCRIPTION_STATUSES` | `bd6fbff` |
| E4-M-2 | MED | `backend/src/services/billing.ts` | Crashed webhook events never reprocessed | crash-retry reprocessing of unacked webhook events | `bd6fbff` |
| E4-M-3 | MED | `backend/src/services/billing.ts` | Canceled-subscription row can be resurrected by a stale event | canceled rows are terminal unless a new subscription id arrives | `bd6fbff` |
| E4-M-4 | MED | `backend/src/services/billing.ts` | Admin override row applied by checkout (privilege confusion) | checkout ignores admin-override rows | `bd6fbff` |
| E4-M-5 | MED | `backend/src/services/billing.ts` | `billingPauseFailed` surfaces but has no reconciliation job (standing residual, §4) | surfaced + logged; reconciliation deferred | `bd6fbff` (partial) |
| E5-M-1 | MED | `frontend/package.json` | postcss CVEs (transitive) unaddressed | npm `overrides` pinning postcss | `7696191` |
| E1-L-1..L-2 | LOW | onpage/routes | Onpage lows: `wordCount` heuristic off-by-one, suggestion dedupe key | `7696191` | — |
| E2-L-1..L-5 | LOW | backend core | E2-L-4: orphan global provider-spend reservations, no reaper (standing, §4); E2-L-5: `ttlMinutes` NaN clamp (no live caller); others fixed | partial | — |
| E3-L-1..L-2 | LOW | frontend | Frontend lows fixed | `58bee77` | — |
| E4-L-1..L-4 | LOW | billing | E4-L-1: stale-dropped `checkout.session.completed` leaks coupon `reserved_count` (standing, §4); E4-L-2: invite-accept dissolve swallows `cancelTenantBilling` failure (standing, §4); E4-L-3: mock pause/resume flattens status (mock-only, standing, §4); E4-L-4: orphaned-Stripe-customer race (customer created before `stripe_customer_id` persisted) (standing, §4) | standing (documented) | — |
| E5-L-1..L-3 | LOW | docs/deps | `SIGNUP_TRIAL_DAYS` undocumented; DEPLOY missing trial section; UNVERIFIED-5 rewritten | `7696191` | — |
| E5 DUP-1/DUP-2 | LOW | — | DUP of D4-L-5 (`.worktrees`) / D4-L-6 (caddy unpinned) — still open, §4 | — | — |

### Pass #6 — auditors F1–F4 (2026-10-11; 0H / 2M (same finding ×2) / 12L)

Fixes: `c97edb1`→`f578ae5` (scheduler), `3cfa84e`+`90877ea`→`bd30bdb` (frontend/docs), `7e4888b`→`b2a2788` (webhooks), `d6998d8`→`9f9dda7` (F2-L-1, then reworked in `81a46be` + `3c59e23`), all merged to `main`. Post-merge: 810 passed / 0 failed.

| ID | Sev | file:line | Finding | Fix | Test |
|---|---|---|---|---|---|
| F1-M-1 | MED | `backend/src/scheduler.ts` | Scheduler `IN (...)` spend lists still authorize `incomplete` → reopens the E4-M-1 never-funded-checkout spend loop | `'incomplete'` removed from both scheduler lists; single spend-authorization definition + wiring doc | `c97edb1`→`f578ae5` |
| F2-M-1 | MED | `backend/src/scheduler.ts` | **Same finding as F1-M-1** (reported by two auditors) | see F1-M-1 | — |
| F1-L-1 | LOW | `backend/src/services/coupons.ts` | `coupon_redemptions` not keyed by Stripe event id → retried webhook double-counts | `event_id` idempotent guard (migration 046) | `7e4888b`→`b2a2788` |
| F1-L-2 | LOW | `backend/src/services/billing.ts` | Admin override on a live Stripe subscription silently desyncs billing | 409 `LIVE_STRIPE_SUBSCRIPTION` when a live sub exists | `7e4888b`→`b2a2788` |
| F1-L-3 | LOW | `backend/src/services/billing.ts` | Checkout adopting an out-of-band Stripe subscription | explicit adopt path | `7e4888b`→`b2a2788` |
| F2-L-1 | LOW | `backend/src/services/scheduler.ts` | `started_at` lease racy under concurrent ticks | first attempt (per-handler event-id guards, migrations 047→048); then **reverted** (`81a46be`) and reworked (`3c59e23`, `providerGuard._q` honored) | — |
| F2-L-2 | LOW | `backend/src/middleware/access.ts` | `requireSubscription` docstring overpromises vs implementation | docstring corrected | `3cfa84e`→`bd30bdb` |
| F2-L-3 | LOW | `backend/src/services/providerGuard.ts` | `_q` parameter ignored in one path | honored | `3c59e23` |
| F2-L-4 | LOW | `backend/src/routes/billing.ts` | Error message on 402 leaks internal plan id | generic message | `3cfa84e`→`bd30bdb` |
| F3-L-1 | LOW | `frontend/components/ErrorBanner.tsx` | Trial copy ambiguous about what happens at trial end | labels clarified | `3cfa84e`→`bd30bdb` |
| F3-L-2 | LOW | `frontend/components/ErrorBanner.tsx` | Upgrade flag missing for read-only users | upgrade flag added | `3cfa84e`→`bd30bdb` |
| F3-L-3 | LOW | `frontend/components/ErrorBanner.tsx` | Read-only reason not shown | reason surfaced | `3cfa84e`→`bd30bdb` |
| F4-L-1 | LOW | `DEPLOY.md` | Migration notes missing for 044–048 | added | `3cfa84e`→`bd30bdb` |
| F4-L-2 | LOW | `backend/src/services/billing.ts` | `BILLABLE_SUBSCRIPTION_STATUSES` comment drift | comment fixed | `3cfa84e`→`bd30bdb` |
| F1–F4 carryovers | — | — | E4-L-1/L-2/L-3, E4-M-5 residual, D1-M-4, D4-L-5/L-6, E3-MED-1 residuals, E2-L-4/L-5, E4-L-4 — all confirmed still present/fixed as before (standing, §4) | — | — |

**Sub-verdicts:** F1 NOT CLEAN (1M+3L), F2 NOT CLEAN (1M+4L), F3 CLEAN (0M+, 3L), F4 not fully clean but zero new medium+ (2L).

### Pass #7 — auditors G1–G5 (2026-10-11; 1H/3M/5L)

Fixes: Next 14→15.5.27/React 19.3.0 upgrade + Caddy `Next-Action` abort rule (merged); `e2dc82c` (billing: G5-M#1 fail-closed, G5-M#2 restore, G5-L#1 refund delta, G1-L-1 dedupe + migration 049); `eb9d9de` (account-security UI: 2FA/password/forgot/billing CTA); G4 docs lows by LA. Regression tests: `backend/tests/wave4/pass7-billing.test.ts` (8/8). Post-merge: 819 passed / 0 failed, tsc clean, frontend build green.

| ID | Sev | file:line | Finding | Fix | Test |
|---|---|---|---|---|---|
| G4-H-1 | HIGH | `frontend/package.json` | **CVE-2026-23869 (GHSA-q4gf-8mx6-v5v3), CVSS 7.5** — remote DoS in Next.js 14.2.35 via malformed `Next-Action` header; **no 14.x backport exists** → framework upgrade required | Next 14.2.35 → **15.5.27** (≥15.5.15 patched), React 18 → **19.3.0**; Caddy abort rule on `Next-Action` (defense-in-depth); `SECURITY.md` updated | — |
| G3-M-1 | MED | `frontend/app/dashboard/*` | Zero account-security self-service: no 2FA enrollment/management UI, no password change, no forgot-password flow | 2FA enrollment/management, password change, forgot/reset flow, billing CTA on locked accounts | `eb9d9de` |
| G5-M#1 | MED | `backend/src/services/billing.ts` (`checkout.session.completed`) | Unexpanded Stripe string subscription ids → backend wrote the row as `incomplete` and fail-closed to read-only, stranding real payers | fail-closed `incomplete` write (kept) **with status-less-checkout order-safety** (see H5-H#1); id expansion fallback | `e2dc82c`; `pass7-billing` |
| G5-M#2 | MED | `backend/src/services/billing.ts` (`invoice.paid` recovery) | Recovery restored plan but not `read_only` → recovered tenants stayed locked | recovery restores plan **and** recomputes `read_only` | `e2dc82c`; `pass7-billing` |
| G1-L-1 | LOW | `backend/src/services/lifecycleEmails.ts` | Lifecycle emails could double-send on retry (no send dedupe) | `(event_id, type)` claim in `notification_log` + migration 049 | `e2dc82c`; `pass7-billing` |
| G3-L-1 | LOW | `frontend/app/dashboard/billing/page.tsx` | Canceled tenants had no resubscribe path | resubscribe CTA | `eb9d9de` |
| G4-L-1..L-2 | LOW | docs | DEPLOY missing 046–049 migration notes; `SECURITY.md` missing CVE entry shape | docs fixed (LA) | — |
| G5-L#1 | LOW | `backend/src/services/billing.ts` | Refund credited the full invoice instead of the delta (double-credit on partial refunds) | delta credit | `e2dc82c`; `pass7-billing` |

**Sub-verdicts:** G1 NOT CLEAN (1L), G2 CLEAN (0 new; only dups), G3 NOT CLEAN (1M+1L), G4 NOT CLEAN (1H+2L), G5 NOT CLEAN (2M+1L).

### Pass #8 — auditors H1–H5 (2026-10-11; 1H/0M/7L unique)

Fixes: all by LA on `main` — `e4772f2` (H5-H#1, H5-L#1, H1-L-2 + 7 billing tests); H2-L-1, H3-L-1/L-2, H4-L-1/L-2 fixed on main (LA). Regression file: `backend/tests/wave4/w4-pass8-billing-fixes.test.ts` (7 tests). Post-merge: full suite green.

| ID | Sev | file:line | Finding | Fix | Test |
|---|---|---|---|---|---|
| H5-H#1 | HIGH | `backend/src/services/billing.ts` (`checkout.session.completed` → `incomplete`) | **Fix-of-a-fix of G5-M#1:** the fail-closed `incomplete` write is order-unsafe — a retried `checkout.session.completed` can clobber a correct `active` row to `incomplete` → real payers locked out on day 15 | status-less writes are order-safe: `CASE` guard protects live statuses; watermark not advanced by status-less writes (watermark exemption); `LIVE SUBSCRIPTION` guard on admin-override checkout | `e4772f2`; `w4-pass8-billing-fixes.test.ts` |
| H5-L#1 | LOW | `backend/src/services/billing.ts` | Refund delta credit not in an explicit transaction (credit + tenant update can split) | explicit transaction with tenant row lock | `e4772f2`; `w4-pass8-billing-fixes.test.ts` |
| H1-L-1 | LOW | — | DUP of H2-L-1 (H1 audited a stale tree) | see H2-L-1 | — |
| H1-L-2 | LOW | `backend/src/services/billing.ts` | Duplicate dunning across lifecycle events (grace mint + retry + invoice events can all dun) | dunning exactly-once-per-episode: only the grace-minting branch duns | `e4772f2`; `w4-pass8-billing-fixes.test.ts` |
| H2-L-1 | LOW | `backend/src/services/lifecycleEmails.ts` | Notification dedupe (049) non-atomic under concurrent delivery | claim-first: insert claim row before sending | LA on main |
| H3-L-1 | LOW | `frontend/app/(auth)/signup/page.tsx` | Signup hints 8-char minimum, backend requires 12 | hint corrected to 12 | LA on main |
| H3-L-2 | LOW | `frontend/app/dashboard/reports/page.tsx` | 5 download-URL builders not `encodeURIComponent`'d | encoded | LA on main |
| H4-L-1 | LOW | `frontend/package.json` | postcss devDep `^8.4.35` vs override `^8.5.29` drift | aligned to `^8.5.29` | LA on main |
| H4-L-2 | LOW | `SECURITY.md` | Missing CVE-2026-23869 entry | added | LA on main |

**Sub-verdicts:** H1 NOT CLEAN (2L, incl. 1 dup), H2 NOT CLEAN (1L), H3 CLEAN at M/H (2L), H4 CLEAN at M/H (2L), H5 NOT CLEAN (1H+1L).

### Pass #9 — auditors I1–I5 (2026-10-11; 0H/1M/10L)

Fixes: `d115ef5` (I5-M#1 + I5-L#1 + I2-L-1 + I2-L-2), `916177f` (I1-L-1 + I1-L-2 + I1-L-3 + migration 050 `checkout_sessions` claim table), `d0a526f` (I4 docs), `33348a6` (I3-L-1) — all on `main`. Regression file: `w4-pass9-fixes.test.ts`. Post-merge: 833 passed / 0 failed.

| ID | Sev | file:line | Finding | Fix | Test |
|---|---|---|---|---|---|
| I5-M#1 | MED | `backend/src/services/billing.ts` (`customer.subscription.updated`) | Handler re-mints grace + re-duns after grace was already consumed → recurring paid-access windows for non-payers | handler mirrors consumed-grace state; no re-mint/re-dun after consumption | `d115ef5`; `w4-pass9-fixes.test.ts` |
| I1-L-1 | LOW | `backend/src/services/billing.ts` | Concurrent `invoice.payment_failed` + `subscription.updated(past_due)` can both mint grace + dun (double grace window, double email) | atomic grace mint: conditional `UPDATE … WHERE grace_state='none'` → exactly one minter | `916177f`; `w4-pass9-fixes.test.ts` |
| I1-L-2 | LOW | `backend/src/services/billing.ts` | Transient mint-send failure swallows the dun (silent lost reminder) | `episodeDunningSent`: re-dun once on the next retry | `916177f`; `w4-pass9-fixes.test.ts` |
| I1-L-3 | LOW | `backend/src/routes/billing.ts` | Double-checkout race: two checkouts for the same tenant both complete | `checkout_sessions` claim table + migration 050 | `916177f`; `w4-pass9-fixes.test.ts` |
| I2-L-1 | LOW | `backend/src/services/reportProcessor.ts` | Report race loser still notifies (loser sends a partial-report notification) | winner-only notification; loser silent | `d115ef5`; `w4-pass9-fixes.test.ts` |
| I2-L-2 | LOW | `backend/src/services/pagespeed.ts` | PageSpeed quota check-then-act overshoot | atomic quota claim before provider call | `d115ef5`; `w4-pass9-fixes.test.ts` |
| I5-L#1 | LOW | `backend/src/services/billing.ts` (`invoice.paid` revival) | Revival matched the wrong subscription id (`invSubId` unset on legacy rows) | `invSubId` match with fallback | `d115ef5`; `w4-pass9-fixes.test.ts` |
| I4-L-1 | LOW | `RELEASE_NOTES.md` | D1-M-4 omission from the known-limitations section | added as limitation #9 | `d0a526f` |
| I4-L-2 | LOW | `AUDIT_RESULT.md` | Audit verification table stale (pass#8 results missing) | table updated | `d0a526f` |
| I4-L-3 | LOW | `docker-compose.prod.yml` | Redis healthcheck uses `-a` with the password on the command line | `REDISCLI_AUTH` env | `d0a526f` |
| I3-L-1 | LOW | `frontend/app/dashboard/reports/page.tsx` | `pdfUrl`/`htmlUrl` raw in the DOM (residual of H3-L-2 area) | `encodeURIComponent` | `33348a6` |

### Pass #10 — auditors J1–J5 (2026-10-11; 0H/1M/11L)

Fixes: `fb1dd4f` (J3-M-1 + the 7 fixed LOWs) on `main`. Regression file: `w4-pass10-fixes.test.ts` (6 tests). 3 LOWs deferred as documented known limitations (§4).

| ID | Sev | file:line | Finding | Fix | Test |
|---|---|---|---|---|---|
| J3-M#1 | MED | `frontend/app/dashboard/billing/success/page.tsx` | `?success=1` notice promises "your plan is active" while the backend fail-closes to `incomplete` → stranded-payer confusion | success notice gated on the fetched subscription: `incomplete` → amber "payment processing" + portal CTA | `fb1dd4f`; `w4-pass10-fixes.test.ts` |
| J5-LOW-1 | LOW | `backend/src/services/billing.ts` | `$0 invoice.paid` revives a `past_due` tenant whose grace was already consumed | revival requires `amount_paid > 0` (unless covered by a coupon) | `fb1dd4f`; `w4-pass10-fixes.test.ts` |
| J5-LOW-2 | LOW | `backend/src/services/billing.ts` | Same-URL idempotent checkout return leaks the coupon reservation | reservation released on idempotent return | `fb1dd4f`; `w4-pass10-fixes.test.ts` |
| J1-LOW-1 | LOW | `backend/src/services/billing.ts` | Checkout claim steal is status-blind (can steal a live session's claim) | status-aware steal: only `creating`>10m or `open`>25h; never live-open (K5-LOW-3 later tightened `open` to 24h) | `fb1dd4f`; `w4-pass10-fixes.test.ts` |
| J1-LOW-2 | LOW | `backend/src/services/billing.ts` | Re-dun after 15 minutes on retry | `recentDunningSent` 15-min guard (shared with J2-LOW-4) | `fb1dd4f`; `w4-pass10-fixes.test.ts` |
| J1-LOW-3 | LOW | `backend/src/services/billing.ts` | `justMinted` same-millisecond `graceDeadline()` collision → double-dun (email-only) | **DEFERRED** — known limitation (RELEASE_NOTES #10a) | — |
| J1-LOW-4 | LOW | `backend/src/services/billing.ts` | Concurrent Smart-Retry both pass `episodeDunningSent` → re-dun (email-only) | **DEFERRED** — known limitation (RELEASE_NOTES #10b) | — |
| J2-LOW-1 | LOW | `backend/src/services/reportProcessor.ts` | Report winner crashes after insert → zero notification, no healer | **DEFERRED** — known limitation (RELEASE_NOTES #10c) | — |
| J2-LOW-2 | LOW | `backend/src/services/billing.ts` | Claim release deletes other sessions' claims | release scoped by completing session id | `fb1dd4f`; `w4-pass10-fixes.test.ts` |
| J2-LOW-3 | LOW | `backend/src/queues.ts` | `enqueueDeduped` has no TTL and no extend → stale claims block re-enqueue | 60s claim TTL + extend | `fb1dd4f`; `w4-pass10-fixes.test.ts` |
| J2-LOW-4 | LOW | `backend/src/services/billing.ts` | Same root as J1-LOW-2 (re-dun window) | see J1-LOW-2 | — |
| J4-LOW-1 | LOW | `DEPLOY.md`, `RUNBOOK.md`, migrations | Migration 050 comment stale; DEPLOY §7 missing 050; RUNBOOK missing `CHECKOUT_IN_PROGRESS` 409 row | docs fixed | `fb1dd4f` |

**Sub-verdicts:** J1 NOT CLEAN (4L), J2 NOT CLEAN (4L), J3 NOT CLEAN (1M), J4 NOT CLEAN (1L), J5 NOT CLEAN (2L).

### Pass #11 — auditors K1–K5 (2026-10-11 → 2026-10-12 ~00:05 PKT; 0H/0M/11L — FIRST CLEAN PASS)

Fixes: all 11 LOWs fixed in `566065e` on `main`. Regression file: `w4-pass11-fixes.test.ts` (4 tests). Post-merge: full suite green.

| ID | Sev | file:line | Finding | Fix | Test |
|---|---|---|---|---|---|
| K1-LOW-1 | LOW | `frontend/public/openapi.json` | `openapi.json` enumerates `/admin/*` paths to the public | admin paths removed from the public spec | `566065e`; `w4-pass11-fixes.test.ts` |
| K2-LOW-1 | LOW | `backend/src/queues.ts` | `enqueueDeduped` extend uses exists-check (TOCTOU vs a concurrent release) | Lua compare-and-exists extend | `566065e`; `w4-pass11-fixes.test.ts` |
| K2-LOW-2 | LOW | `backend/src/scheduler.ts` | One scheduler loop missing per-site try/catch (a site failure aborts the rest of the batch) | per-site try/catch added (the loop L1-1/L2-2 later find in pass#12) | `566065e` |
| K2-LOW-3 | LOW | `backend/src/services/billing.ts` | `checkout.session.completed` fallback `DELETE` overreaches: can delete a live `creating` claim | fallback pinned to claims predating the completing session (`created_at < data.created`) — refined by L2-1 | `566065e` (+ L2-1 test) |
| K3-LOW-1 | LOW | `frontend/components/ErrorBanner.tsx` | `incomplete` mislabeled "Plan limit reached" | cause-branch: `incomplete` → payment-incomplete copy | `566065e` |
| K3-LOW-2 | LOW | `frontend/app/(auth)/reset-password/page.tsx` | Reset token left in the URL after use | `?token=` scrubbed from history on submit | `566065e` |
| K3-LOW-3 | LOW | `frontend/app/dashboard/billing/cancel/page.tsx` | Cancel-flow copy doesn't distinguish `incomplete` checkouts | conditional copy for `incomplete` | `566065e` |
| K4-LOW-1 | LOW | `RUNBOOK.md` | 409 `CHECKOUT_IN_PROGRESS` row inaccurate | row corrected | `566065e` |
| K5-LOW-1 | LOW | `backend/src/services/billing.ts` | `canceled`-tenant revival not guarded by `amount_paid > 0` (J5-LOW-1's guard missed the canceled path) | same `$0` guard applied to canceled revival | `566065e`; `w4-pass11-fixes.test.ts` |
| K5-LOW-2 | LOW | `backend/src/services/lifecycleEmails.ts` | Refund email prints raw cents (`1250` instead of `$12.50`) | cents→dollars formatting | `566065e` |
| K5-LOW-3 | LOW | `backend/src/services/billing.ts` | `open` claim steal threshold 25h (pass#10 set it) lets dead claims linger a day+ | threshold tightened 25h → 24h | `566065e`; `w4-pass11-fixes.test.ts` |

**Sub-verdicts:** K1–K5 all CLEAN at M/H (each reported only LOWs: 1/3/3/1/3). No auditor filed a single HIGH or MEDIUM.

### Pass #12 — auditors L1–L5 (2026-10-12 ~00:30–00:45 PKT; 0H/0M/6L — SECOND CLEAN PASS)

Fixes: all 6 LOWs fixed on `main` — L3's 3 frontend LOWs in `b10bd83`; L2-1/L2-2 + L1-1 (same rank-checks loop) fixed on main by LA with a new L2-1 stealer-claim survival regression test; "5/5 pass#11-fix tests pass" re-run confirmed no regressions. L4 and L5 reported zero findings. **→ Two consecutive clean passes: Final Gate criterion satisfied.**

| ID | Sev | file:line | Finding | Fix | Test |
|---|---|---|---|---|---|
| L1-1 | LOW | `backend/src/scheduler.ts` | Rank-checks loop missing per-site try/catch — **same loop as L2-2** (L1 audited the pre-fix HEAD; not a new defect) | per-site try/catch added | — |
| L2-1 | LOW | `backend/src/services/billing.ts` | K2-3 fallback `DELETE` (even pinned by `created_at < data.created`) can delete a live `creating` claim of the completing session itself | fallback pinned further: delete only claims whose claim token differs / predate the completing session (stealer-claim survival test) | new L2-1 regression test |
| L2-2 | LOW | `backend/src/scheduler.ts` | Rank-checks inline loop missing per-site try/catch (the one loop K2-2's fix missed) | per-site try/catch | — |
| L3-L-1 | LOW | `frontend/components/ErrorBanner.tsx` | ErrorBanner headline not overridable: `incomplete` shows "Payment incomplete." not "Plan limit reached." | headline overridable per cause | `b10bd83` |
| L3-L-2 | LOW | `frontend/components/ErrorBanner.tsx` | Grace-consumed `past_due` shows "Payment failed." alongside payment copy | dedicated grace-consumed copy | `b10bd83` |
| L3-L-3 | LOW | `frontend/components/ErrorBanner.tsx` | Generic read-only "Subscribe" alert renders even when a specific incomplete/past_due alert is shown | generic alert suppressed when specific alerts render | `b10bd83` |

**Sub-verdicts:** L1 CLEAN at M/H (1L), L2 CLEAN at M/H (2L), L3 CLEAN at M/H (3L), L4 CLEAN (0/0/0), L5 CLEAN (0/0/0).

---

## 3. Final-audit results — the two consecutive clean passes

**Pass #11 (2026-10-11 → 2026-10-12 ~00:05 PKT): CLEAN — the first clean pass.**
Zero new HIGH, zero new MEDIUM. 11 new LOWs filed by K1–K5 (1 + 3 + 3 + 1 + 3), **all 11 fixed** in `566065e` on `main`; regression file `w4-pass11-fixes.test.ts` (4/4 passing); full backend suite green, tsc clean, frontend build green. Each K auditor additionally adversarially re-verified all pass#10 fixes and the pass#5–#9 standing fixes — no re-opened defects.

**Pass #12 (2026-10-12 ~00:30–00:45 PKT): CLEAN — the second consecutive clean pass.**
Zero new HIGH, zero new MEDIUM. 6 LOW reports filed: L1 1L + L2 2L + L3 3L + L4 0 + L5 0 (L1-1 and L2-2 are the same rank-checks loop — 5 unique findings). **All 6 fixed** on `main` (`b10bd83` for the 3 frontend LOWs; LA fixes + new stealer-claim regression test for L2-1/L2-2); "5/5 pass#11-fix tests pass" confirmed no regressions; full suite green. L4 (docs/secrets/deps) and L5 (billing/metering) reported literally zero findings.

**Final Gate verdict: PASS.** The program requirement — two consecutive hostile-audit passes with zero new HIGH or MEDIUM findings — was met by passes #11 and #12.

---

## 4. Deferred and known limitations

These items were deliberately left open (or are structural non-fixables). None blocks the Final Gate.

### 4.1 Deferred from pass #10 (explicit product decision; in RELEASE_NOTES.md)

1. **J1-LOW-3** — `justMinted` same-millisecond `graceDeadline()` collision → double-dun. Email-only; vanishingly rare. (RELEASE_NOTES limitation #10a)
2. **J1-LOW-4** — concurrent Smart-Retry both pass `episodeDunningSent` → re-dun. Email-only. (RELEASE_NOTES limitation #10b)
3. **J2-LOW-1** — report winner crashes after insert → zero notification, no healer. (RELEASE_NOTES limitation #10c)

### 4.2 Standing duplicates / long-open items (confirmed present through pass #12)

4. **D4-L-5** — 2.2GB of stale `.worktrees/` copies in the repo directory. Still present (dup-noted passes #5–#12). Local hygiene, not shipped.
5. **D4-L-6** — `caddy:2-alpine` unpinned in `docker-compose.prod.yml`. Still open (dup-noted passes #5–#12); deploy-time pinning procedure documented.
6. **D1-M-4** — crawl reservation TTL < worst-case crawl duration; `ttlMinutes` hook is dead code. Fix remedy recorded as RELEASE_NOTES limitation #9 (TTL scaling was applied).
7. **E4-L-1** — stale-dropped `checkout.session.completed` leaks coupon `reserved_count`. Standing; dup-noted passes #6–#12.
8. **E4-L-2** — invite-accept dissolve swallows `cancelTenantBilling` failure. Standing; dup-noted passes #6–#12.
9. **E4-L-3** — mock Stripe pause/resume flattens status. Mock-only. Standing; dup-noted passes #6–#12.
10. **E4-M-5 residual** — no reconciliation job for `billingPauseFailed` (surface-only). Standing; dup-noted passes #6–#12.
11. **E2-L-4** — orphan global provider-spend reservations have no reaper (self-heal at UTC midnight). Standing; dup-noted passes #7–#12.
12. **E2-L-5** — `ttlMinutes` NaN clamp (no caller can produce NaN today). Standing.
13. **E4-L-4** — orphaned-Stripe-customer race (customer created before `stripe_customer_id` persisted). Standing; dup-noted passes #6, #9.
14. **E3-MED-1 residuals** — no proactive dashboard-wide trial countdown banner; read-only notice only on the billing page (F3 DUP-1/DUP-2, G3 DUP-1/DUP-2).
15. **C1-L-2 residual** — mock-mode `confirm` replay double-redeems a coupon (mock-only; K5 dup).

### 4.3 Watch items and environment deferrals

16. **Next.js Oct-14-2026 OOB release** — 2 Critical + 1 High advisories were announced with advisories unpublished as of 2026-10-11; re-triage required when details land (G4 record).
17. **CVE-2026-23870 (RSC DoS)** — NOT applicable: zero server actions in the codebase; React 19.3.0.
18. **Trivy image scan + `npm audit`** — registry-blocked in this VM (403 policy_denied); must run in CI/on the delivery machine (Wave 1 & Wave 3 records).
19. **Docker verification** — no Docker daemon in this VM; compose smoke test and Trivy image scan deferred to the delivery machine (user decision: do not delay work for Docker).
20. **Playwright axe ruleset** — needs a browser; recorded for CI.

---

## Appendix A — Wave 0 baseline (pre-Wave-4, for completeness)

Before the Wave-4 hostile-audit loop, the master program ran its own audit wave (Oct 10–11, 2026): the Wave-0/1 security audit (22 findings, all fixed in Waves 1–3), the Wave-2 security review (2 HIGH: SSRF in webhook delivery, admin key — both fixed and re-verified before merge), the W-01..W-09 backend/frontend verification sweep (27 findings, all fixed; "WAVE4-FIXES-STATUS" records 27/27), and the wave-3 pre-release QA (all GREEN). Test counts grew 307 → 577 → 711 → 757 → 788 → 802 → 810 → 819 → 833 passing with zero failures across the audit loop. The §1–§4 record above covers the 12 hostile-audit passes themselves.

## Appendix B — regression-test files by round

| Round | Fix commit(s) | Regression test file | Tests |
|---|---|---|---|
| Pass #1 fixes | `agent/wave4-fix-backend` + `cd667ad` | suite (unnamed in PROGRESS) | — |
| Pass #2 fixes | `d61068a` + `0c92292` | suite | 711 passed / 0 failed |
| Pass #3 fixes | `1037c40` (`da9c717` + BE-2 + `00a8d57`) | `w4-fix3-be1.test.ts`, `w4-fix3-be2.test.ts` | 757 / 0 |
| Pass #4 fixes | BE-A/BE-B/FE-C + LA cleanup (unnamed) | suite | 788 / 0 |
| Pass #5 fixes | `7696191`, `23794db`, `bd6fbff`, `58bee77` | suite | 802 / 0 |
| Pass #6 fixes | `c97edb1`, `3cfa84e`+`90877ea`, `7e4888b`, `d6998d8` (+ `81a46be`, `3c59e23`) | `w4-fix4-bea.test.ts`, `w4-fix4-cleanup.test.ts` | 810 / 0 |
| Pass #7 fixes | Next15 upgrade, `e2dc82c`, `eb9d9de` | `pass7-billing.test.ts` | 819 / 0 (8/8 new) |
| Pass #8 fixes | `e4772f2` | `w4-pass8-billing-fixes.test.ts` | 7 new |
| Pass #9 fixes | `d115ef5`, `916177f`, `d0a526f`, `33348a6` | `w4-pass9-fixes.test.ts` | 833 / 0 |
| Pass #10 fixes | `fb1dd4f` | `w4-pass10-fixes.test.ts` | 6 new |
| Pass #11 fixes | `566065e` | `w4-pass11-fixes.test.ts` | 4 new |
| Pass #12 fixes | `b10bd83` + LA fixes | new L2-1 stealer-claim test | — |

*This document is the definitive record of the Beyonix SEO tool Wave-4 hostile-audit loop (passes #1–#12). The raw auditor reports (`.audit-pass{1..12}-*.md`) and the narrative with dates (`PROGRESS.md`) are the primary sources; any conflict is resolved in favor of the auditor reports.*
