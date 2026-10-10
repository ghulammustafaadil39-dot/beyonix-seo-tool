/**
 * Stripe-profile setup. Same as setup.ts but with fake Stripe TEST-MODE
 * secrets so tests in tests/integration/stripe/ exercise the REAL
 * webhooks.constructEvent() signature verification (pure HMAC — no network).
 */
process.env.INTEGRATION_PROFILE = 'stripe';
await import('./setup.js');
