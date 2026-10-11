import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * N-A2-6: a deploy with STRIPE_SECRET_KEY but no STRIPE_WEBHOOK_SECRET would
 * 500 every incoming webhook into a Stripe retry storm. Boot must fail fast
 * instead. (config.ts evaluates at import, so each case re-imports it.)
 */
describe('N-A2-6 webhook secret required with Stripe keys', () => {
  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    vi.resetModules();
  });

  it('throws at boot when STRIPE_SECRET_KEY is set without STRIPE_WEBHOOK_SECRET', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    delete process.env.STRIPE_WEBHOOK_SECRET;
    await expect(import('../src/config.js')).rejects.toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it('boots when both are set', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_123';
    const { config, hasStripe } = await import('../src/config.js');
    expect(hasStripe()).toBe(true);
    expect(config.stripeWebhookSecret).toBe('whsec_123');
  });

  it('boots when neither is set (mock billing)', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { hasStripe } = await import('../src/config.js');
    expect(hasStripe()).toBe(false);
  });
});
