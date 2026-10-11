# Deploy — Beyonix SEO Tool (pre-deploy checklist)

Production deploy: `docker compose -f docker-compose.prod.yml up --build`
(reverse proxy + automatic TLS, healthchecks, resource limits, backup
sidecar). Full operational detail (migrations, backups & restore, key
rotation, incident basics, zero-downtime deploy, env reference) lives in
[RUNBOOK.md](RUNBOOK.md). This file is the go-live gate: **do not go live
until every box below is ticked.**

## Pre-deploy checklist (REQUIRED before go-live)

- [ ] **Pin the Caddy image digest (C4-M1 — BLOCKING).** `docker-compose.prod.yml`
      currently uses the floating tag `caddy:2-alpine`. Caddy is the
      internet-facing TLS terminator — a floating tag is the highest-value
      supply-chain target in the stack. Before go-live, run the documented
      ritual (see the comment above the `caddy` service in
      `docker-compose.prod.yml`):
      `docker pull caddy:2-alpine && docker inspect --format='{{index .RepoDigests 0}}' caddy:2-alpine`,
      then commit `image: caddy:2-alpine@sha256:<digest>` (verify the digest
      corresponds to a genuine Caddy release, e.g. what caddyserver/caddy
      published for that version) and delete the ritual comment.
      **Do not go live with a floating tag.** (All other images in both
      compose files and both Dockerfiles are already digest-pinned.)
- [ ] `.env` fills in every value RUNBOOK's "Environment variable reference"
      requires (`cp .env.example .env`; compose fails fast on the `:?` guards).
- [ ] `JWT_SECRET` ≥ 32 chars, random, not a placeholder (API refuses to boot
      otherwise). `ENCRYPTION_KEY` set for credential encryption.
- [ ] `APP_HOST` / `API_HOST` set to real hostnames in `Caddyfile.prod`
      (defaults are `localhost`; leaving them unset merges the site blocks and
      routes all traffic to one upstream).
- [ ] `METRICS_BASIC_AUTH="user:password"` set so `/metrics` and `/status`
      (spend/queue intel) are not public.
- [ ] Stripe live keys + webhook secret configured if billing is enabled;
      `STRIPE_WEBHOOK_SECRET` matches the live endpoint.
- [ ] Backup sidecar verified: after the first night, confirm the
      `pgbackups` volume is non-empty (`docker compose -f
      docker-compose.prod.yml exec backup ls -la /backups` or the configured
      backup dir). Restore was rehearsed at least once per RUNBOOK
      "Backups & restore".
- [ ] CI is green (build, tests, trivy image scan, gitleaks) on the exact
      commit being deployed.

## Notes

- The compose files are statically validated (YAML) but have never been
  booted in this build environment — the first boot happens on the target
  machine; watch the first `up` closely.
- `web` (frontend) in dev compose carries `env_file: .env` and therefore sees
  backend secrets at runtime (C4-L1, accepted/low); in a hardened prod setup,
  drop `env_file` on `web` and pass only `API_INTERNAL_URL` (+ build args).
