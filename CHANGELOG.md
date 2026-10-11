# Changelog — Beyonix SEO Tool

Seeded from git history on 2026-10-11 (Wave 3, QA/Release Lead). Entries are
grouped by program wave; exact commit messages live in `git log`.

## Wave 0 — baseline (2026-10-10)

- Strong-MVP baseline commit + deep hostile audit (22 findings: 4 high, 11 medium, 7 low).
- Program control docs created: `ARCHITECTURE_PLAN.md`, `PROGRESS.md`, `AUDIT_RESULT.md`; contracts frozen.
- QA batch 1: integration-test harness (real PG/Redis, fake SMTP/webhook catchers), malicious-site crawler fixture, smoke tests.

## Wave 1 — blockers & security (2026-10-10 → 2026-10-11)

- P0-01: password login after logout fixed (`token_version` signed in login/signup) + regression test.
- P0-02: migration advisory lock + per-file transactions; one-shot `migrate`; `/healthz` vs `/readyz` split; compose healthchecks.
- P0-03: runtime API URL (same-origin `/api` proxy route reading `API_INTERNAL_URL` per request; standalone server).
- P0-04: Stripe plan changes via `subscription_data.metadata` + price→plan map; `isPlanId` guard on checkout events.
- P0-05: production fail-closed secrets (`validateSecrets`), signed mock webhooks, mock-confirm disabled in prod.
- S-01: email verification flow + Google merge requires Google `email_verified` AND local verified.
- S-02: SSRF hardening (DNS pinning, rebinding simulation tests, IPv6-transition blocks, size/type caps).
- S-03: `trustProxy`, Redis-backed rate limits, login lockout with backoff, signup abuse protection.
- S-04: OAuth state in Redis + signed httpOnly cookie + PKCE, one-time use, TTL.
- S-05: password reset/change, email change, account/tenant delete+purge, TOTP 2FA, sessions list.
- S-06: Secure/SameSite cookies, CSRF double-submit, helmet-style headers, strict CSP, CORS allow-list.
- S-07: encryption key versioning (`kid`) + rotation script; no base64 fallback outside dev/test.
- S-08: domain verification hardened (exact `<meta name="bseo-verify">`, exact TXT match, weekly re-verify).
- S-09: prompt-injection delimiting + LLM HTML sanitization.
- S-10: container hardening (non-root, read-only, digest-pinned images, Redis auth, resource limits) + Trivy CI workflow.
- N-A1-6: mock Google OAuth fail-closed outside dev/test. JWT-in-body removed (cookie-only session token).
- Wave 1 gate: PASS (307 passed / 9 skipped / 0 failed).

## Wave 2 — billing/data/reliability + product features (2026-10-11)

- C-01: billing completeness — webhook idempotency ledger, `created` ordering guard, invoice/coupon/trial/annual/proration, dunning + grace period, downgrade → read-only (never deletes data), invoices list, replay-safe signed webhooks, mock mirrors real event shapes (incl. `data.object` envelope).
- C-02: metering — reserve-then-commit usage, billing-period windows, 80/100% alerts, DataForSEO cost tracking, hard 402 stops.
- C-03: queue reliability — per-tenant fair scheduling, job timeouts, stalled-job handling, dead-letter queue with replay, graceful shutdown, idempotent processors, scheduler leader election, UTC cron, jittered backoff, circuit breakers.
- C-04: crawler quality — robots crawl-delay + politeness, redirect-chain analysis, canonical/hreflang/sitemap parsing, simhash dedup, structured-data validation, PageSpeed CWV (cached, quota-guarded), crawl resume, incremental recrawl. (Optional Playwright JS-render mode deferred by LA decision.)
- C-05: rank tracking — SERP snapshots, device/location/language, SERP-feature detection, competitor tracking, change alerts, visibility share, shared SERP cache.
- C-06: data lifecycle — retention windows + cleanup jobs, indexes, soft-delete sites, backup/restore scripts, tenant export.
- C-07: API quality — validation everywhere, stable pagination, OpenAPI 3.1 served at `/openapi.json`, `/api/v1` versioned, idempotency keys on paid POSTs, request ids.
- F-01..F-14: onboarding wizard, audit v2, keyword research v2, content engine v2, GEO v2, backlinks v2, competitors, white-label reporting, agency/team + invitations, notifications (email/Telegram/Slack/webhooks), billing UI, marketing site, public API + API keys, admin back-office.
- Security reviews fixed 2 HIGH + 5 MEDIUM across the wave; safeFetch strips credentials on cross-origin redirects.
- Wave-2 QA phase gate: PASS WITH FINDINGS — API journey suites added (core 11/11, billing 7/7, team+API 4/4, chaos DLQ 3/3); BUG-QA-W2-1..W2-4 filed; W2-1/W2-2/W2-4 fixed, W2-3 deferred to Wave 3.
- Wave 2 gate: PASS (577 passed / 9 skipped / 0 failed, tsc clean, frontend build green).

## Wave 3 — quality/ops (in progress, QA/Release Lead)

- Q-01: `integration-stripe` project populated (BUG-QA-W2-3) — 11 real signed webhook tests against the real Stripe provider; coverage measurement on core modules; Playwright E2E attempted; Node load baseline.
- Q-02: `.github/workflows/ci.yml` (lint, tsc, tests+PG/Redis, frontend build, migration dry-run, npm audit, gitleaks, E2E) + `.gitleaks.toml`.
- Q-03: `/metrics` (Prometheus), `/status` JSON + page, pino JSON logging audit, Sentry/OTel env-gated hooks, example alert rules.
- Q-04: README/RUNBOOK/ARCHITECTURE refresh, docs/methodology, CONTRIBUTING, SECURITY, CHANGELOG, `.env.example` complete (proven vs `config.ts`).
- Q-05: `docker-compose.prod.yml` (Caddy TLS, healthchecks, limits, backup sidecar, zero-downtime notes) — static validation only (no Docker daemon in this environment).
- W-09 (QA slice): `backend/scripts/seed.ts` (idempotent demo data), `npm run seed`, `make dev` one-command bootstrap.
