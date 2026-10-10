# Integration tests

Real Postgres + real Redis, no Docker, no external network. Hermetic per test.

## How to run

From `backend/`:

```bash
npm test                        # everything: unit + integration + integration-stripe
npm run test:integration        # integration + integration-stripe projects only
npx vitest run --project integration          # non-stripe integration tests only
npx vitest run --project integration-stripe   # stripe webhook tests only
```

Prerequisites (already running natively on this VM):

- Postgres 16 with database `bseo_test` and role `bseo` (`DATABASE_URL`
  `postgres://bseo:bseo@localhost:5432/bseo_test`)
- Redis 7 on `localhost:6379` (tests use DB **1**; dev uses DB 0)

## Layout

```
tests/integration/
  setup.ts            # env + migrations + fake servers (default profile)
  setup.stripe.ts     # same, but with fake Stripe TEST-MODE secrets
  smoke.test.ts       # harness validation only (not item verification)
  stripe/             # P0-04 webhook tests (valid test-mode signatures)
  helpers/
    app.ts            # buildTestApp() (Fastify, inject-driven), signupUser()
    db.ts             # resetDb(), ensureMigrated(), uniqueEmail()
    redis.ts          # resetRedis() (FLUSHDB on test DB 1)
    fakes.ts          # FakeSmtpCatcher (SMTP protocol), FakeWebhookCatcher (HTTP)
    stripe.ts         # signStripePayload(), stripeEvent() fixture builders
```

## Hermeticity rules

1. **Database** — `resetDb()` in `beforeEach` TRUNCATEs every public table
   (except `migrations`) with CASCADE + RESTART IDENTITY. Table list is read
   from `pg_tables` at runtime, so it stays correct as migrations are added.
   The test database is `bseo_test`; the dev database `bseo` is never touched.
2. **Redis** — tests use DB 1; `resetRedis()` FLUSHDBs it in `beforeEach`.
3. **SMTP** — `SMTP_HOST=127.0.0.1`, `SMTP_PORT=2525` (2526 in the stripe
   profile) point at `FakeSmtpCatcher`, a minimal in-process SMTP server.
   Assert with `getSmtpCatcher().waitForMessage()`; clear with `.clear()`.
4. **Webhooks (outbound)** — point delivery URLs at `FakeWebhookCatcher`
   (port 3525 / 3526 in stripe profile); assert with `.waitForRequest()`.
5. **Stripe (inbound webhook)** — the `integration-stripe` project sets fake
   `sk_test_…` / `whsec_test_…` secrets so the route exercises the REAL
   `stripe.webhooks.constructEvent()` HMAC verification. Fixtures are signed
   locally with `signStripePayload()` — no Stripe network calls, ever.
6. **No real providers** — no Google/DataForSEO/LLM/Telegram calls. Provider
   code runs in mock mode (empty credentials), as documented in
   `ARCHITECTURE_PLAN.md` §3.

## Writing a new integration test

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, signupUser, authHeaders } from './helpers/app.js';
import { resetDb } from './helpers/db.js';
import { resetRedis } from './helpers/redis.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); await resetRedis(); });

describe('my feature', () => {
  it('does the thing', async () => {
    const user = await signupUser(app);
    const res = await app.inject({
      method: 'GET', url: '/api/v1/...', headers: authHeaders(user),
    });
    expect(res.statusCode).toBe(200);
  });
});
```

Rules:

- One Fastify instance per test file (`beforeAll`/`afterAll`); never share
  instances across files. The DB pool and Redis client are worker-scoped and
  stay open — do not close them per file.
- `setupFiles` env must be set before `src/` imports; never set
  `process.env` inside a test file and expect `config` to notice
  (`config.ts` reads env at module-evaluation time).
- Never commit `.env` or real credentials. Test secrets in `setup.ts` are
  fake/local-only values.
- Cross-tenant isolation: every resource test needs a second tenant asserting
  403/404 (no existence leak) — see `ARCHITECTURE_PLAN.md` §3.
- Wave 1 item tests (P0-01, P0-04, S-03, S-05) are written only after the
  owning lead's branch lands; read their branch — never guess at APIs.
