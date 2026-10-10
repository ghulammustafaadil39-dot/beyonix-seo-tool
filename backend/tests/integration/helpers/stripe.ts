/**
 * Stripe test-mode fixtures for integration tests.
 *
 * No network calls: signatures are generated locally with the same HMAC-SHA256
 * scheme Stripe uses (t=<ts>,v1=<hmac>), so they pass the REAL
 * webhooks.constructEvent() verification when STRIPE_WEBHOOK_SECRET is set
 * (the `integration-stripe` vitest project). Tampered payloads must fail
 * verification — assert that too.
 */
import { createHmac } from 'node:crypto';

export const TEST_STRIPE_SECRET_KEY = 'sk_test_integration_fake_000000000000000000000000';
export const TEST_STRIPE_WEBHOOK_SECRET = 'whsec_test_integration_000000000000000000000000';

/** Build a Stripe-style `t=...,v1=...` signature header for a raw JSON body. */
export function signStripePayload(
  rawBody: string,
  secret: string = TEST_STRIPE_WEBHOOK_SECRET,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  const sig = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

/** Wrap a Stripe object payload in a full event envelope. */
export function stripeEvent(type: string, object: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `evt_test_${Date.now()}`,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    type,
    data: { object },
  };
}

export function checkoutSessionCompleted(opts: {
  tenantId: string;
  planId: string;
  customerId: string;
  subscriptionId: string;
}): Record<string, unknown> {
  return stripeEvent('checkout.session.completed', {
    id: 'cs_test_123',
    object: 'checkout.session',
    customer: opts.customerId,
    subscription: opts.subscriptionId,
    metadata: { tenantId: opts.tenantId, planId: opts.planId },
  });
}

export function subscriptionEvent(
  type: 'customer.subscription.created' | 'customer.subscription.updated' | 'customer.subscription.deleted',
  opts: { customerId: string; subscriptionId: string; planId?: string; status?: string },
): Record<string, unknown> {
  return stripeEvent(type, {
    id: opts.subscriptionId,
    object: 'subscription',
    customer: opts.customerId,
    status: opts.status ?? 'active',
    metadata: { planId: opts.planId ?? 'growth' },
  });
}

export function invoicePaymentFailed(opts: { customerId: string; subscriptionId: string }): Record<string, unknown> {
  return stripeEvent('invoice.payment_failed', {
    id: 'in_test_123',
    object: 'invoice',
    customer: opts.customerId,
    subscription: opts.subscriptionId,
  });
}
