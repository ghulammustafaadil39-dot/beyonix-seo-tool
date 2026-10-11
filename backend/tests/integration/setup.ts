/**
 * Integration-test setup (vitest setupFiles). Runs ONCE per worker BEFORE any
 * test-file imports, so process.env assignments here take effect before
 * src/config.ts reads them at module-evaluation time.
 *
 * Profile 'stripe' (setup.stripe.ts) additionally sets fake Stripe TEST-MODE
 * secrets so the REAL webhooks.constructEvent() path is exercised. All other
 * env is identical; only the fake-server ports differ so the two projects can
 * run in parallel workers without port clashes.
 *
 * Secrets below are LOCAL-ONLY test values (fake Stripe keys, throwaway
 * JWT/encryption keys). Never real credentials; never committed to .env.
 */
const profile = process.env.INTEGRATION_PROFILE ?? 'default';
const isStripe = profile === 'stripe';

process.env.NODE_ENV = 'test';
// LA directive: DATABASE_URL comes from the environment when set (per-session
// test DB, e.g. bseo_test_qa); fallback is the shared bseo_test database.
process.env.DATABASE_URL ??= 'postgres://bseo:bseo@localhost:5432/bseo_test';
process.env.REDIS_URL = 'redis://localhost:6379/1';
process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum-ok!!';
process.env.ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.APP_URL = 'http://localhost:3000';
process.env.API_URL = 'http://localhost:4000';

const smtpPort = isStripe ? 2526 : 2525;
const hookPort = isStripe ? 3526 : 3525;
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(smtpPort);
process.env.SMTP_USER = 'qa';
process.env.SMTP_PASS = 'qa';
process.env.SMTP_FROM = 'Beyonix SEO Test <test@beyo.test>';

if (isStripe) {
  process.env.STRIPE_SECRET_KEY =
    'sk_test_integration_fake_000000000000000000000000';
  process.env.STRIPE_WEBHOOK_SECRET =
    'whsec_test_integration_000000000000000000000000';
}

// LA (S-03 test-isolation fix): namespace this run's S-03/S-04 Redis keys and
// flush the namespace, mirroring tests/setup.ts (unit). Integration uses
// Redis DB 1, so this never touches the unit keyspace.
process.env.BSEO_REDIS_PREFIX ??= `bseo:integration:${process.pid}:`;
{
  const { Redis } = await import('ioredis');
  const redis = new Redis(process.env.REDIS_URL as string, {
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
  });
  try {
    const prefix = process.env.BSEO_REDIS_PREFIX as string;
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
  } finally {
    redis.disconnect();
  }
}

const { ensureMigrated } = await import('./helpers/db.js');
const { FakeSmtpCatcher, FakeWebhookCatcher, registerFakes } = await import('./helpers/fakes.js');

await ensureMigrated();
// Vitest re-executes setupFiles once per TEST FILE (isolate:true) inside the
// same worker process. The fake TCP servers can only bind their ports once
// per process, so start them once and share the instances across files via
// globalThis (each file's own module registry still gets them through
// registerFakes()). Keyed by profile so the `stripe` project (separate
// worker process) keeps its own catchers on the stripe ports.
// NOTE for test authors: catcher message/request arrays are shared across
// files in a project — call .clear() in beforeEach when asserting on them.
const g = globalThis as Record<string, unknown>;
const fakesKey = `__bseoFakes_${profile}`;
let fakes = g[fakesKey] as
  | { smtp: FakeSmtpCatcher; hook: FakeWebhookCatcher }
  | undefined;
if (!fakes) {
  fakes = {
    smtp: await FakeSmtpCatcher.start(smtpPort),
    hook: await FakeWebhookCatcher.start(hookPort),
  };
  g[fakesKey] = fakes;
}
registerFakes(fakes.smtp, fakes.hook);
