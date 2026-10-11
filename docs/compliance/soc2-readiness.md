# SOC2-Readiness Checklist (documentation only — Beyonix SEO Tool)

Scope: backend (this doc). Prepared for the Security Lead review (W-07).
Status markers: ✅ implemented · 🟡 partial · ⬜ out of scope (auditor-owned).

## CC6.1 — Logical access security
- ✅ Tenant isolation: every tenant query carries `tenant_id` (contract rule; tests via query-spy).
- ✅ AuthN: bcrypt(12) passwords, HS256 JWT 7d, httpOnly `bseo_token` cookie, TOTP 2FA + backup codes, sessions list, token_version revocation.
- ✅ AuthZ: team roles (owner>admin>editor>viewer) + API-key scopes; `admin` scope never grantable to keys; platform admin 404s for non-admins.
- ✅ API-key hygiene: raw key shown once, sha256 hash stored, human-session required for key management.
- 🟡 Access reviews: no periodic access-review UI (manual via admin back-office + `admin_audit_log`).

## CC6.2 — Credential management
- ✅ Secrets in env, validated at boot (`validateSecrets`: ≥32 chars, placeholder rejection).
- ✅ Stored OAuth/API keys encrypted (AES, `key_version`/`kid` rotation script).
- ✅ Login lockout + rate limits (Redis-backed, per-IP and per-tenant).

## CC6.3 — Data protection
- ✅ Encryption in transit: TLS-terminating reverse proxy expected (docker-compose.prod.yml notes); API emits HSTS via hardening headers.
- ✅ GDPR: `/api/v1/account/export` (full tenant dump, secrets excluded) and `DELETE /api/v1/account/erase` (hard-delete, queues purged).
- ✅ Retention: `retention_policies` table + scheduled cleanup (usage 13mo, audits 12mo, webhook deliveries/DLQ 90d, activity 24mo); `GET /api/v1/account/retention` exposes effective windows.

## CC7.2 — Monitoring & anomaly detection
- ✅ pino JSON logs with request ids; `/metrics` (Q-03); rank-movement anomaly detection (z-score) feeding `rank_alerts`.
- ✅ Provider cost guardrails: per-tenant budgets (402) + global daily spend circuit (503).
- ✅ Dead-letter queue for exhausted jobs, replayable from admin.

## CC7.3 — Change management
- ✅ Migrations ledger (`migrations` table), one-shot migrate service, advisory-lock serialization.
- ⬜ Auditor-owned: formal change-approval records (repo history via git).

## CC8.1 — Incident handling
- ✅ `/.well-known/security.txt` (RFC 9116) with contact `security@beyonixsolutions.com`; `SECURITY.md` documents the disclosure policy.
- 🟡 Incident runbook: operational guidance lives in `README`/runbook (Q-04); no PagerDuty integration by default.

## Evidence scripts (for a future auditor)
1. `npx tsc --noEmit` — type safety.
2. `npm test` — 577+ tests (unit + integration projects).
3. `SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT 20;` — admin actions.
4. `GET /api/v1/account/export` — export completeness.
5. `GET /api/v1/openapi.json` — API surface.
6. Load proof: `npx tsx scripts/load-proof.ts` — throughput + fairness evidence.
7. Bench: `npx tsx scripts/bench-hot.ts` — hot-endpoint p95 numbers.
