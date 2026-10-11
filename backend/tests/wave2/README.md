# tests/wave2/ — QA/Release Lead (Wave 2) integration tests

Owned exclusively by the QA/Release Lead for Wave 2. Other agents: do NOT edit
files in this directory — report needed changes to the LA.

- Tests here run in the `integration` vitest project (see `backend/vitest.config.ts`):
  real Postgres + Redis, single serialized worker, shared test DB taken from
  `DATABASE_URL` (env-first, fallback `bseo_test`).
- Each file must leave the DB clean: use `resetDb()` from
  `../integration/helpers/db.js` in `beforeEach` (or `beforeAll` where the file
  is self-contained), and reuse the helpers in `../integration/helpers/`
  (`app.ts` for a Fastify instance, `stripe.ts` for signed fixtures, `fakes.ts`
  for the SMTP/webhook catchers, `redis.ts`).
- Planned coverage (added as Wave-2 items merge, per LA notice):
  - C-01 Stripe: webhook replayed twice → applied once; payment_failed →
    grace/dunning; downgrade with excess usage → read-only, no data deleted.
  - C-02 metering: concurrent reserve-then-commit → usage never exceeds limit.
  - C-03 reliability: SIGTERM mid-job → retried exactly once, no duplicate
    usage; two scheduler ticks → single enqueue (leader election).
  - C-06 lifecycle: backup → wipe → restore → data matches.
  - F-09 teams: viewer cannot invite (403), editor cannot change plan, owner can.
  - F-13 API keys: wrong scope → 403; revoked key → 401.
  - F-14 admin: non-admin → 403 everywhere; impersonation writes audit-log row.
