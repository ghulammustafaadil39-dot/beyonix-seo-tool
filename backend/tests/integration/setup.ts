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
process.env.DATABASE_URL = 'postgres://bseo:bseo@localhost:5432/bseo_test';
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

const { ensureMigrated } = await import('./helpers/db.js');
const { FakeSmtpCatcher, FakeWebhookCatcher, registerFakes } = await import('./helpers/fakes.js');

await ensureMigrated();
registerFakes(await FakeSmtpCatcher.start(smtpPort), await FakeWebhookCatcher.start(hookPort));
