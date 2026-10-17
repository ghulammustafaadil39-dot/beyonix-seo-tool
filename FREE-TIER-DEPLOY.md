# FREE-TIER-DEPLOY.md — $0 review deployment of the SEO tool (for Talal's check)

Purpose: put a live copy of the SEO tool online for Talal to review, spending $0.
NOT a production setup — see DEPLOY.md for the real production path (VPS + Docker + Caddy).
Prepared 2026-10-17 from the tool's DEPLOY.md service map + verified 2026 free-tier facts.

## What the tool needs (from DEPLOY.md service map)

| Piece | In compose | Free-tier home |
|---|---|---|
| Web UI (Next.js standalone, :3000) | `web` | Vercel Hobby (free) |
| API (Fastify, :4000) | `api` | Render free web service |
| Worker (BullMQ + in-process scheduler) | `worker` | **gap — see §Worker below** |
| Postgres 16 | `postgres` | Supabase free (new project) |
| Redis 7 | `redis` | Upstash free |
| One-shot migration | `migrate` | run once from his laptop (see §Migrations) |
| Caddy / TLS / backups | `caddy`, `backup` | not needed (platform TLS; review data only) |

## Verified free-tier facts (checked 2026-10-17)

- **Render Hobby ($0):** free web services sleep after 15 min idle (~1 min cold start on next
  request); 512 MB RAM; 750 instance hours/month per workspace ≈ **one** always-on service,
  not several; no persistent disk; no outbound mail on ports 25/465/587.
- **Render free does NOT include background workers** (need Starter $7/mo) and **cannot run
  one-off jobs/shells** on free. Render's own free Postgres **expires 30 days after creation**
  — do NOT use it; use Supabase instead.
- **Supabase free:** 2 active projects (beyonix-admin already occupies one — a second project
  is allowed), 500 MB Postgres each, 5 GB egress/mo, unlimited API requests, **no automated
  backups**. Projects **pause after 7 days of no DB activity** (one-click resume; a periodic
  ping keeps it alive). Use the **pooler connection string** (`*.pooler.supabase.com`) —
  direct connections are IPv6-only and most PK ISPs don't route IPv6.
- **Upstash free:** 1 Redis database, 256 MB, 500k commands/month, 10 GB bandwidth/month,
  persistent. BullMQ needs the native TCP (`rediss://`) endpoint, which Upstash provides.
- **Vercel Hobby:** free; fits the Next.js frontend. The frontend's `/api/*` same-origin proxy
  route forwards to `API_INTERNAL_URL` — set it to the Render API URL.

## Deploy steps (review only)

1. **Supabase:** create project #2 (region ap-south-1 Mumbai, same as beyonix-admin).
   Copy the pooler `DATABASE_URL`. Enable `pgcrypto` if migrations need it.
2. **Upstash:** create free Redis, copy the `rediss://` URL + password → `REDIS_URL`.
3. **Migrations (from his laptop):** in the v1.1.0 folder, set `DATABASE_URL` to the Supabase
   pooler string and run the one-shot migrate (`node dist/migrate.js` after build, or the
   backend migrate script) — schema lands once; the `migrate` compose service isn't needed
   on the free stack.
4. **Render:** new Web Service → deploy from the repo's `backend/Dockerfile` (root dir `backend`),
   env: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `NODE_ENV=production`,
   plus whatever `.env.example` marks required for API. Health check → `/readyz`.
   Expect ~1 min cold starts after idle — fine for review.
5. **Vercel:** new project from the repo's `frontend/` dir; env: `API_INTERNAL_URL=<render-api-url>`
   (+ any `NEXT_PUBLIC_*` from `.env.example`). Deploy.
6. **Email verification:** leave `DEV_BYPASS_EMAIL_VERIFICATION=true` on the review deploy
   (no real SMTP on free tiers); real SMTP only matters for production.
7. **Mock modes stay on:** keyword/AI/billing test modes keep the review at $0 (no DataForSEO key).

## The worker gap (the one honest decision)

The worker runs BullMQ queues + the in-process scheduler (autopilot's scheduled jobs).
Options:

- **A. $7/mo Render Starter background worker** — the only paid piece; everything else $0.
  Clean, no code changes. (Recommended if Talal needs to see scheduled autopilot runs.)
- **B. Manual triggers for review** — API + web on free tiers; Talal triggers audits/jobs from
  the UI instead of waiting for the scheduler. $0, no code change, but no background schedule.
- **C. HTTP-triggered jobs via pg_cron** — needs a small code change (cron endpoints on the API
  that enqueue BullMQ jobs); pg_cron already runs on the beyonix-admin Supabase project.
  $0, but code work + review of the new endpoints.

## Caveats to tell Mustafa/Talal plainly

- Review deploy only: Render API sleeps when idle; Supabase pauses after 7 idle days
  (resume in one click); no DB backups on free — don't put real customer data here.
- Never use Render's free Postgres (30-day expiry) — Supabase is the DB.
- 750 Render instance-hours/month ≈ one always-on service: keep only the API on Render free.
- When real customers come: production path is DEPLOY.md (VPS) or paid tiers
  (Supabase Pro $25/mo, Render Starter $7/mo × services).

## What delivery should still verify (live, at deploy time)

- Render dashboard: API service is on the free instance type and `/readyz` is green.
- Supabase: second project created under the same org; pooler string works from Render
  (test one query).
- Upstash: command count stays far under 500k/mo during review.
- Vercel: `API_INTERNAL_URL` points at the live Render URL (no localhost).
