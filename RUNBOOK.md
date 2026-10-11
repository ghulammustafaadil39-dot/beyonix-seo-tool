# Runbook — Beyonix SEO Tool (Wave 3)

Operations guide for the person running the production deployment.
Everything here has been checked against the actual code and compose files;
commands that were not executed in this environment are marked as such.

## Test-database bootstrap (dev/CI on this VM)

VM snapshot reverts periodically wipe `/tmp` and can revert the `bseo` role
password. Before running backend tests, re-assert the environment:

```bash
source ~/workspace/.local/qa-env.sh   # recreates bseo_test_qa, re-asserts the role password
cd backend && npm test                  # or: npx vitest run --project integration-stripe
```

`qa-env.sh` adapts the Backend-A pattern (`~/workspace/.local/ba-env.sh`):
fixed password `bseo_local_dev_pw` (dev-only), `DATABASE_URL` +
`REDIS_URL` exports. **Lesson learned (Wave 2): never override
`DATABASE_URL` manually for verification runs — trust the setup files.**
The canonical test database for the QA/Release role is `bseo_test_qa`.

## Start / stop (local dev, no Docker)

```bash
# one-command bootstrap (installs, migrates, seeds, starts API+worker+web):
make dev
# or manually:
cd backend && npm install && npm run build
node dist/migrate.js                     # one-shot migrations
npm run seed                             # demo data (idempotent; login demo@beyonix.local / DemoPass123!)
npm start &                              # API on :4000
npm run start:worker &                   # workers + scheduler
cd ../frontend && npm install && npm run dev   # web on :3000
```

Stop: `Ctrl-C` each process (both API and worker install graceful-shutdown
handlers that drain in-flight work before exiting).

## Start / stop (Docker — compose files)

```bash
cp .env.example .env   # fill in EVERY value; compose fails fast on :? guards
docker compose up --build -d                 # dev compose (docker-compose.yml)
docker compose -f docker-compose.prod.yml up --build -d   # production
```

> `docker compose` was NOT executed in this environment (no Docker daemon —
> user decision, Docker verifications deferred). Both compose files are
> YAML-validated and mirror the Wave-1/Wave-2 dev file; the prod file has not
> been booted anywhere yet. Re-verify on first prod deploy.

## Migrations

- One-shot runner: `node dist/migrate.js` (also runs advisory-locked at API/worker boot).
- Migrations are additive files `backend/migrations/NNN_*.sql`, applied once
  each inside their own transaction; a `migrations` ledger table tracks them.
- Never edit an applied migration. New schema → new numbered file.
- Dry-run in CI: the `migration-dry-run` job applies all migrations to a
  wiped database.

## Backups & restore

```bash
# full custom-format backup (compressed, table-restorable)
DATABASE_URL=<prod url> ./backend/scripts/backup.sh /backups/bseo-2026-10-11.dump
# restore to a scratch database for verification
DATABASE_URL=<scratch url> ./backend/scripts/restore.sh /backups/bseo-2026-10-11.dump
```

The prod compose file runs a nightly `backup` sidecar (volume `pgbackups`,
on-host retention by the operator). Restore rule: always restore to a
scratch database first, verify the app boots + `/readyz` is 200, then
promote.

## Key rotation

- **Encryption keys** (stored OAuth/API keys): generate a new 32-byte hex key,
  prepend it to `ENCRYPTION_KEYS` as `newkid:hex...` (first = primary), then
  `cd backend && npm run rotate-keys` (re-encrypts existing ciphertext).
- **JWT_SECRET**: issue a new 32+ char secret, deploy, then all users must log
  in again (sessions are JWTs; old ones stop validating). There is no rolling
  window — schedule a maintenance window.
- **Stripe webhook secret / MOCK_WEBHOOK_SECRET**: rotate in the dashboard,
  update `.env`, redeploy.
- **REDIS_PASSWORD / POSTGRES_PASSWORD**: change in `.env` + the DB, redeploy.

### Tenant BYOK keys (operator note)

Tenants can bring their own LLM key (`llm_provider` + key in tenant
settings; encrypted with `ENCRYPTION_KEYS`). **Fail-closed by design
(A2-H1):** a stored key with no explicit `llm_provider` is silently ignored
(never sent to a guessed provider). If a tenant reports "my key isn't
being used", check that *both* provider and key are set. Tenant keys use
the same key-versioning as server keys — rotate `ENCRYPTION_KEYS` and run
`npm run rotate-keys` to re-encrypt.

## Incident basics

| Symptom | First checks |
|---|---|
| 5xx spike | `GET /status` (db/redis flags), `GET /metrics` (queue depth, error series) |
| Webhooks not applying | `stripe_webhook_events` ledger — replay-safe; check `last_event_at` ordering guard and `dead_letter_jobs` |
| Queue stuck | `/admin` dead-letter queue (replay/discard); `bseo_queue_jobs{state="failed"}` in metrics |
| Suspected rogue admin session | `/admin` audit log shows every impersonation (`impersonate` rows with `asUserId`); impersonation tokens are 5-min JWTs registered as sessions — revoke the session to kill it immediately |
| High provider cost | `/admin/spend` (provider_spend trailing 30d); per-tenant spend in `provider_spend` |
| Auth failures spike | login-lockout counters (Redis); check `RATE_LIMIT_PER_MIN` / `AUTH_RATE_LIMIT_PER_MIN` tuning |
| Customer reports "checkout blocked" / 409 `CHECKOUT_IN_PROGRESS` | Normal: a `checkout_sessions` row exists for the tenant (in-flight or abandoned checkout). It self-heals — completed/expired webhooks release it; a crashed `'creating'` claim is stolen by the next attempt after 10 min; a live `'open'` claim is never stolen (reuses the session URL). Only investigate if it persists >25h (then the claim row + Stripe dashboard state deserve a look) |

## Zero-downtime deploy

1. `docker compose -f docker-compose.prod.yml pull` (or build) the new images.
2. Run the migration container first: `docker compose -f docker-compose.prod.yml run --rm migrate`
   (migrations are backward-compatible by contract — new code must tolerate the old schema for one deploy).
3. Recreate services one at a time: `docker compose -f docker-compose.prod.yml up -d --no-deps api`,
   wait for `/readyz` 200, then `worker`, then `web`.
4. Verify `/status` ok on the new containers before removing the old ones.
5. Roll back: re-tag the previous images and repeat; never roll back across a
   migration that added a NOT NULL column.

## Environment variable reference

`.env.example` is complete and commented — every variable the backend reads
was proven by grepping `backend/src/config.ts` (`opt()`/`req()` calls) plus
the live-`process.env` reads in services/providers/routes (Wave 3 audit,
2026-10-11). Highlights:

- **Secrets**: `JWT_SECRET` (32+ random chars, placeholders rejected),
  `ENCRYPTION_KEY`/`ENCRYPTION_KEYS` (32-byte hex), `COOKIE_SECRET`,
  `MOCK_WEBHOOK_SECRET` (dev/test only), `STRIPE_WEBHOOK_SECRET` (required
  whenever `STRIPE_SECRET_KEY` is set — boot fails fast otherwise),
  `POSTGRES_PASSWORD`, `REDIS_PASSWORD`.
- **Safety**: `NODE_ENV` defaults to **production** (fail-closed); mock
  billing is impossible in production; mock webhooks disabled in production.
- **Rate limits**: `RATE_LIMIT_PER_MIN`, `AUTH_RATE_LIMIT_PER_MIN`,
  `TENANT_EXPENSIVE_LIMIT_PER_HOUR`, login-lockout trio.
- **Observability**: `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT` (env-gated,
  no hard dependency); `GET /metrics`, `GET /status` always available.

## How CI maps to local commands

| CI job | Local equivalent |
|---|---|
| backend-lint-typecheck | `cd backend && npx tsc --noEmit` |
| backend-tests | `cd backend && npm test` (all 3 vitest projects) |
| backend-tests coverage | `cd backend && npm run test:coverage` (core ≥ 85%) |
| frontend-build | `cd frontend && npm run build` (+ `npx tsc --noEmit`) |
| migration-dry-run | `node dist/migrate.js` against a wiped DB |
| npm-audit | `npm audit --audit-level=high` (blocked locally by registry policy — CI must cover) |
| secret-scan | gitleaks with `.gitleaks.toml` |
| e2e-smoke | `tests/wave2/journey-*.test.ts` API journeys + Playwright (see docs/qa/wave3-results.md) |
| trivy | separate workflow (image scan; NOT runnable here — no Docker daemon) |

![CI](https://github.com/beyonix/beyonix-seo-tool/actions/workflows/ci.yml/badge.svg)
