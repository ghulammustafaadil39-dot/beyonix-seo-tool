# Production Deploy Verification — Beyonix SEO Tool

**Verifier:** deploy-verifier subagent (Final Gate) · **Date:** 2026-10-11
**Branch:** `main` @ `beffaae` · **Method: STATIC VALIDATION ONLY — this VM has no Docker
daemon, so `docker compose up`, image builds, container healthchecks, and live
migrations were NOT executed.** Everything below was verified by parsing
`docker-compose.prod.yml` with Python `yaml.safe_load`, reading the
Dockerfiles, Caddyfile, backup scripts, and the migration runner source.

---

## 1. docker-compose.prod.yml — verified (static parse ✓)

YAML parses cleanly. 8 services: `postgres`, `redis`, `migrate`, `api`,
`worker`, `web`, `caddy`, `backup`. Volumes: `pgdata`, `redisdata`,
`pgbackups`, `caddydata`, `caddyconfig`. No networks section (compose default
network — fine).

| Check | Result |
|---|---|
| Services defined | api, worker, web, postgres, redis, caddy, migrate, backup — all present |
| Port conflicts | None — only `caddy` publishes ports (`80:80`, `443:443`) |
| Hardcoded secrets | None found in compose. All credentials flow via `${VAR}` from `.env` |
| Fail-fast guards (`${VAR:?}`) | `POSTGRES_PASSWORD` (7 refs), `REDIS_PASSWORD` (4 refs), `APP_HOST` (1 ref). `API_HOST`, `APP_TLS_EMAIL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL` are intentionally optional (`:-`) |
| Volume mounts | All sane: named volumes for pgdata/redisdata/pgbackups/caddydata/caddyconfig; `./Caddyfile.prod` → `/etc/caddy/Caddyfile:ro`; backup scripts mounted `:ro` with `_pg_env.sh` correctly co-mounted (the file comments call this out) |
| Healthchecks | postgres (`pg_isready -U bseo`), redis (`redis-cli ping` via `REDISCLI_AUTH`, not `-a`), api (`/readyz` — route exists at `backend/src/index.ts:125`), worker (ioredis ping via `REDIS_URL`), web (HTTP `/` on 3000). All have interval/timeout/retries + sane `start_period`s |
| depends_on ordering | Correct boot chain: migrate waits postgres+redis healthy; api/worker wait postgres+redis healthy AND migrate `service_completed_successfully`; web waits api healthy; backup waits postgres healthy + migrate completed; caddy waits api+web healthy. No cycles |
| read_only filesystems | api, worker, web are `read_only: true` with `tmpfs` mounts. No `writeFileSync`/`createWriteStream`/`appendFileSync` found anywhere in `backend/src` — nothing writes to the container fs at runtime. web mounts `/app/.next/cache` tmpfs for Next.js ISR cache as the file comments |
| env precedence | `environment:` overrides `env_file: .env`, so the dev-placeholder `DATABASE_URL` in `.env.example` cannot leak into prod — the prod URLs are recomputed from `POSTGRES_PASSWORD`/`REDIS_PASSWORD` |
| Digest pinning | postgres, redis, node base images all sha256-pinned. **Caddy is NOT pinned** (see gap G-1) |

## 2. Caddyfile.prod — verified

- `web:3000` ← matches `web` service (standalone Next.js, `HOSTNAME=0.0.0.0`, `PORT=3000` in `frontend/Dockerfile`) ✓
- `api:4000` ← matches `api` service (`PORT: 4000` in compose) ✓
- TLS: `tls {$APP_TLS_EMAIL:}` — with empty email renders as bare `tls` (valid; Let's Encrypt allows no-account-email). APP_HOST fail-fast is in compose (`docker-compose.prod.yml:214`), so the "duplicate localhost" start failure is guarded.
- Next-Action header abort rule present (CVE-2026-23869 defense) — consistent with the file's claim of zero Server Actions.
- Single-hostname alternative (comment out api block, set only APP_HOST) is documented and coherent with the Next.js same-origin proxy route.

## 3. Wiped-machine boot path — traced (static)

```
cp .env.example .env  →  docker compose -f docker-compose.prod.yml up --build -d
  ├─ postgres, redis start; healthchecks gate everything downstream
  ├─ migrate (docker-compose.prod.yml:62-69): build ./backend → `node dist/migrate.js`
  │     → runMigrations() (backend/src/db.ts:92): advisory lock → readdir migrations/
  │       sorted lexically → each file in its own transaction, recorded in `migrations` table
  ├─ api, worker: wait migrate service_completed_successfully → boot
  ├─ backup (docker-compose.prod.yml:238): waits migrate completed → first pg_dump on startup, then 24h loop
  ├─ web: waits api healthy → Next.js standalone on :3000
  └─ caddy: waits api+web healthy → ACME certs for APP_HOST/API_HOST
```

- **Migrations 001–050:** the runner sorts `*.sql` files lexically; with
  zero-padded 3-digit prefixes the on-disk set runs in numeric order. **Files
  008, 009, 031–039 do not exist** — the runner skips them silently (name-based
  tracking, no sequence check), so boot is not blocked. Statements use
  `IF NOT EXISTS` guards, so re-runs are idempotent.
- **Seed step:** none in compose — by design; `SEED_DEMO` is guarded against
  production use (`.env.example`). Fresh prod DB starts empty; first tenant
  comes via signup.

## 4. `.env.example` coverage of every `${VAR}` in compose

All 7 referenced variables are documented:

| Var | Compose refs | Guard | Documented in .env.example |
|---|---|---|---|
| `POSTGRES_PASSWORD` | 7× | `:?` | ✓ S-10 section, "must set", `openssl rand -hex 24` |
| `REDIS_PASSWORD` | 4× | `:?` | ✓ same |
| `APP_HOST` | 1× | `:?` | ✓ prod-deploy section ("required" note in Caddyfile) |
| `API_HOST` | 1× | optional | ✓ documented, may stay empty for single-host setup |
| `APP_TLS_EMAIL` | 1× | optional | ✓ documented, optional |
| `NEXT_PUBLIC_API_URL` | 1× | optional | ✓ documented (rebuild needed if changed) |
| `NEXT_PUBLIC_SITE_URL` | 1× | optional | ✓ documented — **but see gap G-2** |

Other critical secrets (`JWT_SECRET`, `ENCRYPTION_KEY`, `STRIPE_WEBHOOK_SECRET`)
are NOT `:?`-guarded in compose — they are enforced by app boot-time checks
(code refuses production boot on weak/placeholder values), documented in
`.env.example`. Acceptable, but the fail-fast happens at container boot rather
than `compose config` time.

---

## Gaps found

**G-1 — Caddy image NOT digest-pinned (pre-deploy action, self-acknowledged).**
`docker-compose.prod.yml:205`: `image: caddy:2-alpine` is a floating tag while
every other image is sha256-pinned. The file itself contains a detailed comment
requiring the operator to pin the digest before first production deploy (Caddy
is the internet-facing TLS terminator — highest-value supply-chain target).
**Do not go live with the floating tag.**

**G-2 — `NEXT_PUBLIC_SITE_URL` build arg is silently dropped (functional bug).**
`docker-compose.prod.yml:155` passes `NEXT_PUBLIC_SITE_URL` as a `web` build
arg, but `frontend/Dockerfile:22` declares only `ARG NEXT_PUBLIC_API_URL` —
the undeclared arg is ignored by the Docker build. Consequence: the frontend
always falls back to the hardcoded `'https://app.beyonixseo.com'` in
`frontend/app/layout.tsx:5`, `frontend/app/robots.ts:5`, and
`frontend/app/sitemap.ts:8`. Setting `NEXT_PUBLIC_SITE_URL` in `.env` has NO
effect — sitemap/robots/SEO meta will be wrong for any other domain. Fix:
add `ARG NEXT_PUBLIC_SITE_URL` to `frontend/Dockerfile` (or remove the dead
build arg from compose).

**G-3 — `deploy.resources` limits are inert under plain `docker compose up`.**
`docker-compose.prod.yml` sets cpu/memory limits in `deploy.resources` on every
service, but these are only honored in Swarm mode; `docker compose up`
silently ignores them. Not a boot blocker, but resource exhaustion protection
assumed by the file does not exist on a single-host deploy.

**G-4 — Full migration validity not provable without a live Postgres.**
The migration chain (39 files, 001–050 with gaps) was traced statically: the
runner is correct, files are transactional and idempotent. But whether the SQL
itself applies cleanly to a fresh database (e.g. a statement referencing an
object from a missing migration number) cannot be verified on this VM —
`docker compose up` on a wiped machine is the only real proof. Honest status:
**boot path statically sound, runtime proof still pending** (requires Docker).

---

## Not runnable here (honest list)

- `docker compose config` validation / `:?` guard behavior
- Image builds (backend, frontend) and digest-pin freshness
- Actual container boot, healthcheck behavior, depends_on sequencing
- Live migration run 001→050 on a fresh Postgres
- Caddy ACME issuance and reverse-proxy routing
- Backup sidecar's first `pg_dump` + `pg_restore --list` verification

**Bottom line:** the deploy package is statically coherent — service
topology, ordering, healthchecks, env guards, secrets handling, and the
migration mechanism all check out. Two items must be fixed before first
production deploy: pin the Caddy digest (G-1, operator action) and declare
`ARG NEXT_PUBLIC_SITE_URL` in the frontend Dockerfile (G-2, code fix). The
definitive proof — a wiped-machine `docker compose up` — still requires Docker
and must be run before go-live.
