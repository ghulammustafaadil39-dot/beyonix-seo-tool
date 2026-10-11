# DEPLOY.md — Production deployment (wiped-machine procedure)

Static review: 2026-10-11 (Delivery-Prep Worker 2). This file, `docker-compose.prod.yml`
and `Caddyfile.prod` were reviewed against the code with a YAML parser; they have
**NOT** been executed under Docker (no Docker daemon in this environment — see
UNVERIFIED at the bottom). Every step below names the real file it comes from.

Target command (master prompt §10): from a wiped machine with only `.env` created,

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

## 1. Service map (from `docker-compose.prod.yml`)

| Service | Image / build | Purpose |
|---|---|---|
| `postgres` | `postgres:16-alpine` (digest-pinned) | Primary database; data in `pgdata` volume |
| `redis` | `redis:7-alpine` (digest-pinned) | Queues, rate limits, sessions; password via `REDIS_PASSWORD`; data in `redisdata` |
| `migrate` | builds `./backend` (`backend/Dockerfile`) | **One-shot**: runs `node dist/migrate.js` (`backend/src/migrate.ts`), then exits. `api`/`worker`/`backup` wait on `service_completed_successfully`, so schema lands exactly once before anything boots. |
| `api` | builds `./backend` | Fastify API on `:4000`; `/healthz` (liveness) vs `/readyz` (readiness); healthcheck polls `/readyz` |
| `worker` | builds `./backend`, `node dist/worker.js` | BullMQ worker (+ in-process scheduler — see note in compose file); healthcheck pings Redis via ioredis |
| `web` | builds `./frontend` (`frontend/Dockerfile`, Next.js standalone) | Serves the UI on `:3000`; `/api/*` same-origin proxy route (`frontend/app/api/[...path]/route.ts`) forwards to `API_INTERNAL_URL` per request |
| `caddy` | `caddy:2-alpine` (**not** digest-pinned — TODO in compose file) | Reverse proxy + automatic ACME TLS; config from `Caddyfile.prod` |
| `backup` | `postgres:16-alpine` (digest-pinned) | Runs `backend/scripts/backup.sh` once at startup (after `migrate`), then every 24h, into the `pgbackups` volume |

Nothing publishes database ports: only Caddy binds host ports `80`/`443`. All
inter-service traffic stays on the default compose network.

## 2. Prerequisites

- A Linux host (any distro) with **Docker Engine + Compose v2** installed.
- Ports **80 and 443** open to the internet (Caddy needs both for ACME HTTP-01).
- **DNS**: A records for your two hostnames → the host's public IP, e.g.
  `APP_HOST=app.example.com`, `API_HOST=api.example.com`. Create these **before**
  first boot or Caddy cannot issue certificates.
- Outbound HTTPS (Let's Encrypt, Stripe, Google, DataForSEO, LLM providers).
- ~4 GB RAM recommended (compose resource limits sum to ~5 GB worst case).

## 3. Deploy steps (wiped machine)

```bash
# 0. Clone and enter the repo
git clone <repo-url> beyonix-seo-tool && cd beyonix-seo-tool
git checkout <release-tag>   # e.g. the tag from RELEASE_NOTES.md

# 1. Create .env from the example (compose reads env_file: .env in repo root)
cp .env.example .env

# 2. Generate secrets (values below are EXAMPLES — generate your own)
openssl rand -hex 32   # -> JWT_SECRET        (min 32 chars; placeholders rejected at boot)
openssl rand -hex 32   # -> ENCRYPTION_KEY    (32-byte hex; or use versioned ENCRYPTION_KEYS)
openssl rand -hex 32   # -> MOCK_WEBHOOK_SECRET (unused in prod, but set it anyway)
openssl rand -hex 24   # -> POSTGRES_PASSWORD (hex only: embedded in DATABASE_URL)
openssl rand -hex 24   # -> REDIS_PASSWORD    (hex only: embedded in REDIS_URL)
```

> Boot refuses to start in production (`NODE_ENV` anything but `development`, and
> compose sets `NODE_ENV=production`) unless `JWT_SECRET` is 32+ random chars and
> `ENCRYPTION_KEY` is a 32-byte hex string — see `.env.example` header and
> `backend/src/config.ts` (`validateSecrets`, S-01/P0-05).

```bash
# 3. Fill in .env — at minimum the REQUIRED block of the checklist (§8).
#    Compose fails fast (`${VAR:?}` guards) on POSTGRES_PASSWORD,
#    REDIS_PASSWORD and APP_HOST if you forget them.

# 4. Build + start everything
docker compose -f docker-compose.prod.yml up --build -d

# 5. Watch the one-shot migration, then the services
docker compose -f docker-compose.prod.yml logs -f migrate   # expect "[migrate] schema up to date"
docker compose -f docker-compose.prod.yml ps                # migrate: exited 0; rest: running (healthy)
```

Verify:

```bash
curl -sk https://$APP_HOST/status | head -c 300        # JSON status from the API (via Caddy)
docker compose -f docker-compose.prod.yml logs caddy  # expect "certificate obtained" for both hosts
```

## 4. First boot: admin (owner) account

There is **no production seed** — `backend/scripts/seed.ts` refuses to run with
`NODE_ENV=production` unless `SEED_DEMO=1` is set deliberately (never do this on a
real database).

1. Open `https://$APP_HOST/signup` and create your account. The first user of a
   new tenant is created with role `owner` (`backend/src/routes/auth.ts`).
2. **Email verification is required** before paid/spend routes work (S-01). The
   verification link is emailed to you (`APP_URL/verify-email?token=…`,
   `backend/src/services/emailVerification.ts`) — so configure **SMTP before
   first boot** (checklist §8), and set `APP_URL=https://$APP_HOST` or the link
   in the email points at the wrong host.
3. No SMTP yet? Fallback (manual, traceable to the `users.email_verified_at`
   column): `docker compose -f docker-compose.prod.yml exec postgres psql -U
   bseo -c "UPDATE users SET email_verified_at=now() WHERE email='you@example.com';"`.
   Prefer real SMTP — the fallback bypasses the ownership proof.

Optional hardening right after: enable TOTP 2FA on the owner account
(Settings → Security; S-05) and set `AUTH_RATE_LIMIT_PER_MIN` low (default 20).

## 5. TLS (Caddy)

`Caddyfile.prod` defines two site blocks, `{$APP_HOST}` → `web:3000` and
`{$API_HOST}` → `api:4000`, each with `tls {$APP_TLS_EMAIL:}`. On first boot
Caddy obtains and thereafter auto-renews ACME certificates; cert state persists
in the `caddydata` volume.

- Set `APP_TLS_EMAIL` to a real address (ACME account + expiry notices).
- **Single-hostname alternative** (documented in `Caddyfile.prod`): comment out
  the `api` block, set only `APP_HOST`, and keep `COOKIE_SAMESITE=lax` — the
  Next.js `/api` proxy route forwards to the API, so there are no CORS /
  cross-site cookie concerns.

## 6. Backup & restore

- The `backup` service runs `backend/scripts/backup.sh` at startup (after
  `migrate`) and every 24h into the `pgbackups` volume as
  `bseo-YYYY-MM-DD.dump` (custom format, verified with `pg_restore --list`).
- **Off-site copy is the operator's job** — sync `/var/lib/docker/volumes/…
  pgbackups` (or `docker cp`) to S3/object storage; there is no S3 code in the
  backup path.
- Manual backup / restore (from the repo, per `RUNBOOK.md` "Backups & restore"):

```bash
docker compose -f docker-compose.prod.yml exec backup /usr/local/bin/backup.sh /backups/manual.dump
# restore ALWAYS to a scratch database first, verify the app boots and
# /readyz is 200, then promote:
docker compose -f docker-compose.prod.yml exec backup /usr/local/bin/restore.sh /backups/bseo-YYYY-MM-DD.dump
```

- Retention: on-host retention is the operator's (prune old dumps in
  `pgbackups`); container log retention is enforced per service in compose
  (`json-file`, `max-size`/`max-file`).

## 7. Upgrades

Follow `RUNBOOK.md` "Zero-downtime deploy" (migrations are backward-compatible
by contract):

```bash
git pull && git checkout <new-tag>
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm migrate   # migrations first
docker compose -f docker-compose.prod.yml up -d --no-deps api     # wait /readyz 200
docker compose -f docker-compose.prod.yml up -d --no-deps worker  # wait healthy
docker compose -f docker-compose.prod.yml up -d --no-deps web     # wait healthy
curl -sk https://$APP_HOST/status
```

Rollback: re-checkout the previous tag and repeat; **never roll back across a
migration that added a NOT NULL column** (RUNBOOK.md).

### Wave-4 billing migrations (E5-L-2)
- **044** adds `tenants.trial_ends_at` (NOT NULL, backfilled to +100 years for
  existing tenants = grandfathered) and activates the trial gate: new signups
  get a 14-day trial (`SIGNUP_TRIAL_DAYS`); after expiry with no live
  subscription, spend routes return 402 `SUBSCRIPTION_REQUIRED` and the tenant
  is flipped read-only. Operator-visible behavior change — verify trial
  expiry handling on first deploy.
- **045** replaces the sites `UNIQUE (tenant_id, domain)` constraint with a
  partial unique index (`WHERE deleted_at IS NULL`), so soft-deleted domains
  can be re-added; and creates `global_provider_guard`. That table is now
  vestigial: the atomic global provider-spend circuit is serialized by an
  xact-scoped advisory lock (`pg_advisory_xact_lock`, see
  `backend/src/services/providerGuard.ts`), not by guard rows — production
  code never reads or writes the table.
- **046** adds `coupon_redemptions(event_id PK, tenant_id, coupon_code)`: the
  `checkout.session.completed` coupon redeem is idempotent on the webhook
  event id, so a reprocessed (crash-retry) or concurrently-duplicate-delivered
  event cannot double-redeem. Backward-compatible; no operator action.
- **047** added `stripe_webhook_events.started_at` (a lease distinguishing
  concurrent duplicates from crashed attempts) and **048** reverts it — the
  lease broke crash recovery and was replaced by per-handler event-id guards
  (`coupon_redemptions` for coupons, `tenant_credits.webhook_event_id` UNIQUE
  for refund credits). Net schema effect of 047+048: one dropped column, one
  added UNIQUE column. Backward-compatible; no operator action.
- **049** adds `notification_log.event_id` (nullable) + a partial unique index
  on `(event_id, notification_type)`: customer lifecycle emails are deduped on
  (webhook event id, billing event type), so a reprocessed webhook cannot send
  the same dunning/refund email twice. Backward-compatible; no operator
  action.
- **050** adds `checkout_sessions` (one row per tenant, `tenant_id` PK):
  an in-flight checkout claim that closes the double-checkout race (two
  overlapping `POST /billing/checkout` calls creating two Stripe sessions).
  Lifecycle: inserted `'creating'` under the tenant row lock → marked
  `'open'` with the Stripe session id + URL → released by
  `checkout.session.completed` / `checkout.session.expired` (scoped to the
  completing session id) or the route's failure path. A second checkout
  while a live claim exists gets 409 `CHECKOUT_IN_PROGRESS` — or the open
  session's URL when plan/interval match (idempotent double-click). Steal
  rule (status-aware): a `'creating'` claim older than 10 min (creator
  crashed mid-flight) is stolen by the next attempt; a live `'open'` claim
  is never stolen (its Stripe session is payable for 24h); an `'open'`
  claim older than 24h (session expired, webhook lost) is
  stolen. No operator action; see RUNBOOK.md for the 409's meaning.

Note: `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_SITE_URL` are **baked into the
frontend at build time** (`.env.example` "Frontend / same-origin API proxy"
section) — changing them requires `up --build`. `API_INTERNAL_URL` is read per
request and needs no rebuild.

## 8. Deployment checklist (from the env vars the code actually reads)

### REQUIRED (app won't boot or won't serve correctly without these)

- [ ] `POSTGRES_PASSWORD`, `REDIS_PASSWORD` — hex from `openssl rand -hex 24`
      (no special chars: both are interpolated into `DATABASE_URL`/`REDIS_URL`;
      compose fails fast if missing)
- [ ] `JWT_SECRET` — 32+ random chars (`openssl rand -hex 32`); known
      placeholders are rejected at boot
- [ ] `ENCRYPTION_KEY` — 32-byte hex (or versioned `ENCRYPTION_KEYS`,
      `kid:hex,…`, first entry = primary for new encryptions)
- [ ] `APP_HOST`, `API_HOST` — bare hostnames; DNS A records → this host
      **before** first boot. Only `APP_HOST` has a compose fail-fast guard
      (`${APP_HOST:?…}`); `API_HOST` is not guarded — leave it empty only
      for the single-hostname setup (api block commented out in
      `Caddyfile.prod`), otherwise Caddy fails at boot with
      "duplicate site address".
- [ ] `APP_URL=https://$APP_HOST` — used in verification emails/links
- [ ] `API_URL=https://$API_HOST` (or `https://$APP_HOST` for single-hostname)
- [ ] `APP_TLS_EMAIL` — ACME account email
- [ ] `GOOGLE_REDIRECT_URI` — must be the **public** callback URL
      (`https://$API_HOST/api/v1/gsc/callback`), not the localhost default

### Strongly recommended before launch

- [ ] **SMTP** (`SMTP_HOST/PORT/USER/PASS/FROM`) — without it no verification,
      password-reset, or report emails can be delivered (they only hit container
      logs). Port 587 default; 465 = implicit TLS.
- [ ] **Stripe** — `STRIPE_SECRET_KEY` **and** `STRIPE_WEBHOOK_SECRET` (boot
      fails fast if the secret is set without the webhook secret);
      `STRIPE_PRICE_STARTER/GROWTH/PRO` price IDs, plus
      `STRIPE_PRICE_*_ANNUAL` if you sell annual plans (annual checkout errors
      without them). Without keys, billing runs in mock mode.
- [ ] **Google OAuth** (`GOOGLE_CLIENT_ID/SECRET`) — without them GSC/GA4 run on
      mock data. Authorized redirect URI in Google Cloud = `GOOGLE_REDIRECT_URI`.
- [ ] **DataForSEO** (`DATAFORSEO_LOGIN/PASSWORD`) — without them keyword/SERP
      data is mocked (cached).
- [ ] **LLM** — `GEMINI_API_KEY` and/or `OPENAI_API_KEY` (first available wins;
      none = mock drafts). Set `LLM_PROVIDER=gemini` if both exist.
      `LLM_TENANT_DEFAULT_CAP_WORDS` caps per-tenant generation spend.
- [ ] `TRUST_PROXY` — compose already sets `1` on api/worker (Caddy is the
      proxy); do not override to `false` in `.env` or rate limits see only
      Caddy's IP.
- [ ] `COOKIE_SAMESITE` — `lax` (default, correct for the same-origin `/api`
      proxy); only use `none` for split app/api domains *without* the proxy
      (forces Secure).
- [ ] `CORS_ORIGINS` — unset = `APP_URL` only; set explicitly for split domains.
- [ ] Abuse controls — `RATE_LIMIT_PER_MIN` (default 300), `AUTH_RATE_LIMIT_PER_MIN`
      (default 20), `LOGIN_LOCKOUT_MAX_ATTEMPTS/BASE_MIN/MAX_MIN`,
      `DISPOSABLE_EMAIL_BLOCK=true` and `CAPTCHA_PROVIDER=hcaptcha` (+
      `CAPTCHA_SECRET/SITEKEY`) if signup abuse is a concern.
- [ ] `TENANT_EXPENSIVE_LIMIT_PER_HOUR` — per-tenant budget for expensive
      endpoints (default 30; re-read per request, no reboot to tune).
- [ ] **Backups** — confirm dumps appear in the `pgbackups` volume after first
      boot; set up the off-site sync; decide on-host retention.
- [ ] **Log retention** — compose sets `json-file` `max-size`/`max-file` per
      service; confirm host disk monitoring covers `/var/lib/docker`.
- [ ] `NEXT_PUBLIC_SITE_URL` — public site URL used by sitemap/robots/SEO meta.

### Optional / situational

- [ ] `TELEGRAM_BOT_TOKEN` — ops alerts; without it notifications are log-only.
- [ ] `CMS_PUBLISH_ENABLED=true` — only if using the WordPress/Webflow publish
      connector (HTTPS targets only).
- [ ] `PAGESPEED_API_KEY` / `PAGESPEED_DAILY_QUOTA` — PageSpeed works keyless at
      current volumes; set a key only if quota becomes a problem.
- [ ] `SENTRY_DSN` / `OTEL_EXPORTER_OTLP_ENDPOINT` — observability hooks
      (operator-wrapped, no hard dependency).
- [ ] `DB_STATEMENT_TIMEOUT_MS` — per-statement pg timeout guardrail.
- [ ] Pin `caddy:2-alpine` to a reviewed digest before first deploy (TODO in
      compose file; Trivy CI job covers image scanning).

## 9. UNVERIFIED (needs a Docker daemon — none exists in this environment)

1. `docker compose -f docker-compose.prod.yml config` and the full
   `up --build` were **never run**. First real run must be treated as the
   true verification of this file.
2. Image digests for `postgres:16-alpine` and `redis:7-alpine` were not
   verified as resolvable/pullable; `caddy:2-alpine` is unpinned by design
   (see checklist).
3. Backend/frontend Docker builds not executed: `npm ci` (no-lockfile-drift
   rule), `npm run build` → `dist/migrate.js` presence, prompt-template copy
   check, frontend standalone output.
4. Healthcheck commands not executed (api `/readyz` fetch, worker ioredis
   ping, web `/` fetch, `pg_isready`, `redis-cli -a`).
5. **Backup sidecar**: scripts (`backup.sh`, `restore.sh`, `_pg_env.sh`) are
   POSIX-`sh` clean (E5-L-3: the old bash-shebang concern is resolved — all
   three use `#!/bin/sh`). The genuinely unverified part is the **restore
   path**: `restore.sh` has never been executed end-to-end. Test on first
   deploy with a scratch database before trusting backups.
6. Caddy ACME issuance/renewal against real DNS, and the "duplicate site
   address" failure mode the `:?` guards protect against, are reasoned from
   docs, not observed.
7. `read_only: true` + `tmpfs` behavior for api/worker/web (incl. the new
   `/app/.next/cache` mount) needs a runtime check.
8. The `$$` → `$` entrypoint rendering and the backup-first-then-loop
   schedule are standard compose behavior, not observed here.
9. `service_healthy` semantics for `caddy → web` now rest on the added
   explicit web healthcheck; behavior still needs a live compose run.

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `compose config` fails with `set APP_HOST in .env` | `APP_HOST` (or `POSTGRES_PASSWORD`/`REDIS_PASSWORD`) missing in `.env` — fail-fast guard working as intended |
| Caddy logs "duplicate site address" | Both site blocks resolved to the same hostname (see §5); set distinct `APP_HOST`/`API_HOST` or use the single-hostname alternative |
| Caddy can't get certificates | DNS A records not pointing at the host, or ports 80/443 blocked |
| `migrate` exits non-zero, api/worker never start | Read `logs migrate`; fix DB connectivity/migration, then `up -d` again (one-shot re-runs safely — advisory lock, P0-02) |
| Signup works but no verification email | SMTP not configured — mail is log-only (`[notify:mock-email]` in `api` logs); see §4 |
| Frontend shows API errors after changing `NEXT_PUBLIC_*` | Those are build-time baked — `up --build` again (§7) |
| `backup` container restarting | Read `logs backup`; first suspects: `_pg_env.sh` misconfiguration or DB unreachable. If the sidecar never ran a successful restore, treat backups as untrusted until the scratch-DB restore test passes (UNVERIFIED-5) |
