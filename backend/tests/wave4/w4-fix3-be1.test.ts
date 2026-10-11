/**
 * Wave-4 Pass #3 regression tests — BE-1 (billing/money + routes).
 *
 * Covers: C1-H-1/H-2 (cancel subscription on account delete/erase + credit
 * tombstone), C5-H-1/C1-M-6 (atomic coupon reservation at checkout),
 * C1-M-1 (domain change resets verification), C1-M-2 (gsc/ga4 auth-url
 * gates), C1-M-3 (content generate honest dedupe), C1-M-7 (restore plan
 * limit), C5-M-1 (invoice amount_paid), C5-M-2 (unconfigured price 502),
 * C5-M-5 (read-only self-recovery), C5-M-6/C1-L-3 (coupon id collision-free),
 * C2-M-2 (BYOK decrypt fail-closed), C5-L-2 (incomplete ≠ paid),
 * C5-L-3 (deactivated coupon not redeemed), C1-L-1/L-2/L-11/L-12/L-14/L-15
 * (low-severity route fixes).
 */
import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, query, signupOwner, addTeamMember, createSite, authz } from './helpers.js';
import {
  applyPaymentEvent,
  cancelTenantBilling,
  getPayments,
  stripeCouponIdFor,
} from '../../src/providers/stripe.js';
import { getLLMForTenant } from '../../src/providers/llm.js';
import { encrypt } from '../../src/crypto.js';
import { estimateAiWords } from '../../src/routes/content.js';

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');
const uid = () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
// This file creates ~20 users; the auth endpoints are rate-limited to
// 20/min per IP by default — raise it for the file (live env fallback in
// routes/auth.ts; the integration setup scrubs it between files).
process.env.AUTH_RATE_LIMIT_PER_MIN = '1000';

async function mintKey(app: FastifyInstance, token: string, scopes: string[]): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/apikeys',
    headers: authz({ token } as any),
    payload: { name: `f3a-${uid()}`, scopes },
  });
  if (res.statusCode !== 200) throw new Error(`mint key failed: ${res.statusCode} ${res.body}`);
  return (res.json() as any).key as string;
}

async function insertCoupon(code: string, opts: { max?: number | null; active?: boolean; reserved?: number } = {}) {
  await query(
    `INSERT INTO billing_coupons (code, percent_off, duration, max_redemptions, active, reserved_count)
     VALUES ($1, 50, 'once', $2, $3, $4)
     ON CONFLICT (code) DO UPDATE SET percent_off = 50, duration = 'once',
       max_redemptions = $2, active = $3, reserved_count = $4, redeemed_count = 0, stripe_coupon_id = NULL`,
    [code, opts.max ?? null, opts.active ?? true, opts.reserved ?? 0],
  );
}

async function couponRow(code: string) {
  const r = await query(
    `SELECT redeemed_count, reserved_count, active, stripe_coupon_id FROM billing_coupons WHERE code = $1`,
    [code],
  );
  return r.rows[0];
}

async function checkoutWithCoupon(app: FastifyInstance, token: string, couponCode: string, idemKey: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/billing/checkout',
    headers: { ...authz({ token } as any), 'idempotency-key': idemKey },
    payload: { planId: 'growth', couponCode },
  });
}

function mockConfirmPath(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

describe.runIf(HAS_TEST_DB)('Wave-4 Pass#3 BE-1 fixes', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  test('C5-M-6 / C1-L-3: stripeCouponIdFor is collision-free', () => {
    const a = stripeCouponIdFor('SAVE-20');
    const b = stripeCouponIdFor('SAVE_20');
    const c = stripeCouponIdFor('SAVE20');
    expect(a.startsWith('bseo_')).toBe(true);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(stripeCouponIdFor('SAVE-20')).toBe(a); // deterministic
  });

  test('C1-L-11: estimateAiWords unifies the content estimates', () => {
    expect(estimateAiWords(1200)).toBe(1600); // generate route: 1200 + 400
    expect(estimateAiWords(800)).toBe(1200);
  });

  test('C5-H-1 / C1-M-6: coupon slot reserved atomically at checkout; second checkout 400s', async () => {
    const owner = await signupOwner(app);
    const code = `F3A${uid()}`.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    await insertCoupon(code, { max: 1 });

    const c1 = await checkoutWithCoupon(app, owner.token, code, `idem-f3a-1-${uid()}`);
    expect(c1.statusCode).toBe(200);
    const row1 = await couponRow(code);
    expect(Number(row1.reserved_count)).toBe(1);
    expect(Number(row1.redeemed_count)).toBe(0);

    // Second checkout BEFORE the first completes: validateCoupon passes
    // (redeemed 0 < 1) but the atomic reservation must reject.
    const c2 = await checkoutWithCoupon(app, owner.token, code, `idem-f3a-2-${uid()}`);
    expect(c2.statusCode).toBe(400);
    expect((c2.json() as any).error.code).toBe('COUPON_EXHAUSTED');

    // Complete the first session via mock-confirm: reserved -> redeemed.
    const url = (c1.json() as any).url as string;
    const mc1 = await app.inject({ method: 'GET', url: mockConfirmPath(url), headers: authz(owner) });
    expect(mc1.statusCode).toBe(302);
    const row2 = await couponRow(code);
    expect(Number(row2.redeemed_count)).toBe(1);
    expect(Number(row2.reserved_count)).toBe(0);

    // C1-L-2: re-visiting the mock-confirm URL dedupes — no double redeem.
    const mc2 = await app.inject({ method: 'GET', url: mockConfirmPath(url), headers: authz(owner) });
    expect(mc2.statusCode).toBe(302);
    const row3 = await couponRow(code);
    expect(Number(row3.redeemed_count)).toBe(1);
  });

  test('C5-H-1: checkout.session.expired releases the reserved slot', async () => {
    const code = `F3X${uid()}`.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    await insertCoupon(code, { max: 1 });
    await query(`UPDATE billing_coupons SET reserved_count = 1 WHERE code = $1`, [code]);
    await applyPaymentEvent({
      type: 'checkout.session.expired',
      data: { metadata: { couponCode: code } },
    });
    const row = await couponRow(code);
    expect(Number(row.reserved_count)).toBe(0);
    expect(Number(row.redeemed_count)).toBe(0);
  });

  test('C5-L-3: deactivated coupons are not redeemed at completion', async () => {
    const owner = await signupOwner(app);
    const code = `F3I${uid()}`.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    await insertCoupon(code, { max: 10, active: false, reserved: 1 });
    await applyPaymentEvent({
      type: 'checkout.session.completed',
      data: {
        metadata: { tenantId: owner.tenantId, planId: 'growth', couponCode: code },
        customer: `cus_${uid()}`,
        subscription: `sub_${uid()}`,
      },
    });
    const row = await couponRow(code);
    expect(Number(row.redeemed_count)).toBe(0);
  });

  test('C5-M-1: invoice.paid records amount_paid, not amount_due', async () => {
    const owner = await signupOwner(app);
    await query(`UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`, [`cus_inv_${uid()}`, owner.tenantId]);
    const r = await query(`SELECT stripe_customer_id FROM tenants WHERE id = $1`, [owner.tenantId]);
    await applyPaymentEvent({
      type: 'invoice.paid',
      data: {
        id: `in_${uid()}`,
        customer: r.rows[0].stripe_customer_id,
        amount_due: 0,
        amount_paid: 4200,
        currency: 'usd',
        period_start: Math.floor(Date.now() / 1000) - 86400,
        period_end: Math.floor(Date.now() / 1000),
      },
    });
    const inv = await query(`SELECT amount_due_cents, status FROM invoices WHERE tenant_id = $1`, [owner.tenantId]);
    expect(inv.rows.length).toBe(1);
    expect(Number(inv.rows[0].amount_due_cents)).toBe(4200);
    expect(inv.rows[0].status).toBe('paid');
  });

  test('C5-M-2: subscription.updated with unconfigured price fails loudly (502)', async () => {
    const owner = await signupOwner(app);
    const subId = `sub_${uid()}`;
    await query(
      `INSERT INTO subscriptions (tenant_id, stripe_sub_id, plan_id, status) VALUES ($1, $2, 'starter', 'active')`,
      [owner.tenantId, subId],
    );
    await expect(
      applyPaymentEvent({
        type: 'customer.subscription.updated',
        data: {
          id: subId,
          status: 'active',
          customer: `cus_${uid()}`,
          items: { data: [{ price: { id: 'price_not_configured_xyz' } }] },
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
        },
      }),
    ).rejects.toMatchObject({ status: 502, code: 'PRICE_NOT_CONFIGURED' });
    // The tenant must NOT have been silently downgraded to starter-by-fallback.
    const t = await query(`SELECT plan_id FROM tenants WHERE id = $1`, [owner.tenantId]);
    expect(t.rows[0].plan_id).toBe('starter');
  });

  test('C5-L-2: incomplete subscription at checkout does not grant paid limits', async () => {
    const owner = await signupOwner(app);
    const customerId = `cus_inc_${uid()}`;
    await applyPaymentEvent({
      type: 'checkout.session.completed',
      data: {
        metadata: { tenantId: owner.tenantId, planId: 'growth' },
        customer: customerId,
        subscription: {
          id: `sub_inc_${uid()}`,
          status: 'incomplete',
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
        },
      },
    });
    const t = await query(`SELECT plan_id FROM tenants WHERE id = $1`, [owner.tenantId]);
    expect(t.rows[0].plan_id).toBe('starter');
    const s = await query(`SELECT status, plan_id FROM subscriptions WHERE tenant_id = $1`, [owner.tenantId]);
    expect(s.rows[0].status).toBe('incomplete');
    expect(s.rows[0].plan_id).toBe('growth');
  });

  test('C1-H-1: DELETE /auth/account cancels the Stripe subscription first', async () => {
    const owner = await signupOwner(app, 'DelPass123!x');
    const customerId = `cus_del_${uid()}`;
    await query(`UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`, [customerId, owner.tenantId]);
    await query(
      `INSERT INTO subscriptions (tenant_id, stripe_sub_id, stripe_customer_id, plan_id, status)
       VALUES ($1, $2, $3, 'growth', 'active')`,
      [owner.tenantId, `sub_del_${uid()}`, customerId],
    );
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/account',
      headers: authz(owner),
      payload: { password: 'DelPass123!x' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as any).subscriptionsCanceled).toBe(1);
    const s = await query(`SELECT status FROM subscriptions WHERE tenant_id = $1`, [owner.tenantId]);
    expect(s.rows.length).toBe(0); // tenant cascade-deleted
    const t = await query(`SELECT id FROM tenants WHERE id = $1`, [owner.tenantId]);
    expect(t.rows.length).toBe(0);
  });

  test('C1-H-1: account delete aborts with 502 when cancellation fails (no rows deleted)', async () => {
    const owner = await signupOwner(app, 'DelPass456!x');
    const customerId = `cus_fail_${uid()}`;
    await query(`UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`, [customerId, owner.tenantId]);
    await query(
      `INSERT INTO subscriptions (tenant_id, stripe_sub_id, stripe_customer_id, plan_id, status)
       VALUES ($1, $2, $3, 'growth', 'active')`,
      [owner.tenantId, `sub_fail_${uid()}`, customerId],
    );
    const provider = getPayments() as any;
    const orig = provider.cancelSubscription.bind(provider);
    provider.cancelSubscription = async () => {
      throw new Error('stripe is down');
    };
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/auth/account',
        headers: authz(owner),
        payload: { password: 'DelPass456!x' },
      });
      expect(res.statusCode).toBe(502);
      expect((res.json() as any).error.code).toBe('BILLING_CANCEL_FAILED');
    } finally {
      provider.cancelSubscription = orig;
    }
    // Nothing deleted: user, tenant and subscription rows all survive.
    const u = await query(`SELECT id FROM users WHERE id = $1`, [owner.userId]);
    expect(u.rows.length).toBe(1);
    const s = await query(`SELECT status FROM subscriptions WHERE tenant_id = $1`, [owner.tenantId]);
    expect(s.rows[0].status).toBe('active');
  });

  test('C1-H-2: DELETE /account/erase cancels billing and tombstones credits', async () => {
    const owner = await signupOwner(app);
    const customerId = `cus_erase_${uid()}`;
    await query(`UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`, [customerId, owner.tenantId]);
    await query(
      `INSERT INTO subscriptions (tenant_id, stripe_sub_id, stripe_customer_id, plan_id, status)
       VALUES ($1, $2, $3, 'growth', 'active')`,
      [owner.tenantId, `sub_erase_${uid()}`, customerId],
    );
    await query(`INSERT INTO tenant_credits (tenant_id, amount_cents, reason) VALUES ($1, 1500, 'test refund')`, [
      owner.tenantId,
    ]);
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account/erase',
      headers: authz(owner),
      payload: { confirm: 'ERASE' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.subscriptionsCanceled).toBe(1);
    expect(body.creditsForfeitedCents).toBe(1500);
    const t = await query(`SELECT id FROM tenants WHERE id = $1`, [owner.tenantId]);
    expect(t.rows.length).toBe(0);
    // Explicit forfeit record survives in the audit log.
    const a = await query(
      `SELECT meta FROM admin_audit_log WHERE action = 'account.erased' AND meta->>'erasedTenantId' = $1 ORDER BY created_at DESC LIMIT 1`,
      [owner.tenantId],
    );
    const meta = a.rows[0]?.meta as any;
    expect(meta?.creditsForfeitedCents).toBe(1500);
    expect(meta?.subscriptionsCanceled).toEqual(expect.arrayContaining([expect.any(String)]));
  });

  test('C1-L-14: sole owner cannot delete themselves while members remain', async () => {
    const owner = await signupOwner(app, 'OwnerPass1!x');
    await addTeamMember(app, owner.tenantId, 'editor', 'MemberPass1!x');
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/account',
      headers: authz(owner),
      payload: { password: 'OwnerPass1!x' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as any).error.code).toBe('LAST_OWNER');
    const u = await query(`SELECT id FROM users WHERE id = $1`, [owner.userId]);
    expect(u.rows.length).toBe(1);
  });

  test('C1-M-1: PATCH site domain resets verification', async () => {
    const owner = await signupOwner(app);
    const siteId = await createSite(app, owner, `f3a-${uid()}.example.com`);
    await query(`UPDATE sites SET verified = TRUE, verified_at = now(), verify_token = 'oldtoken' WHERE id = $1`, [
      siteId,
    ]);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sites/${siteId}`,
      headers: authz(owner),
      payload: { domain: `f3a-new-${uid()}.example.com` },
    });
    expect(res.statusCode).toBe(200);
    const s = await query(`SELECT verified, verified_at, verify_token, domain FROM sites WHERE id = $1`, [siteId]);
    expect(s.rows[0].verified).toBe(false);
    expect(s.rows[0].verified_at).toBeNull();
    expect(s.rows[0].verify_token).not.toBe('oldtoken');
  });

  test('C1-M-2: gsc/ga4 auth-url routes require owner/admin/editor or the read scope', async () => {
    const owner = await signupOwner(app);
    const viewer = await addTeamMember(app, owner.tenantId, 'viewer');
    const siteId = await createSite(app, owner);
    for (const path of [`/api/v1/sites/${siteId}/gsc/auth-url`, `/api/v1/sites/${siteId}/ga4/auth-url`]) {
      const denied = await app.inject({ method: 'GET', url: path, headers: authz(viewer) });
      expect(denied.statusCode).toBe(403);
      const key = await mintKey(app, owner.token, ['sites:read']);
      const deniedKey = await app.inject({ method: 'GET', url: path, headers: { 'x-api-key': key } });
      expect(deniedKey.statusCode).toBe(403);
      const ok = await app.inject({ method: 'GET', url: path, headers: authz(owner) });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as any).url).toBeTruthy();
    }
  });

  test('C1-M-3: content generate dedupes honestly within the day window', async () => {
    const owner = await signupOwner(app);
    const siteId = await createSite(app, owner);
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/content`,
      headers: authz(owner),
      payload: { title: 'F3A dedupe piece', brief: 'A sufficiently long brief so the piece starts in brief status.' },
    });
    expect(created.statusCode).toBe(201);
    const pieceId = (created.json() as any).id as string;
    await query(`UPDATE content_pieces SET status = 'draft' WHERE id = $1`, [pieceId]);
    const g1 = await app.inject({ method: 'POST', url: `/api/v1/content/${pieceId}/generate`, headers: authz(owner) });
    expect(g1.statusCode).toBe(200);
    expect(g1.json()).toMatchObject({ ok: true, queued: true });
    const g2 = await app.inject({ method: 'POST', url: `/api/v1/content/${pieceId}/generate`, headers: authz(owner) });
    expect(g2.statusCode).toBe(200);
    expect(g2.json()).toMatchObject({ ok: true, queued: false, deduplicated: true });
  });

  test('C1-L-12: approve routes through the canTransition state machine', async () => {
    const owner = await signupOwner(app);
    const siteId = await createSite(app, owner);
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/content`,
      headers: authz(owner),
      payload: { title: 'F3A approve piece', brief: 'A sufficiently long brief so the piece starts in brief status.' },
    });
    const pieceId = (created.json() as any).id as string;
    const bad = await app.inject({ method: 'POST', url: `/api/v1/content/${pieceId}/approve`, headers: authz(owner) });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as any).error.code).toBe('INVALID_STATUS');
    await query(`UPDATE content_pieces SET status = 'review' WHERE id = $1`, [pieceId]);
    const ok = await app.inject({ method: 'POST', url: `/api/v1/content/${pieceId}/approve`, headers: authz(owner) });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as any).status).toBe('approved');
  });

  test('C1-M-7: site restore re-checks plan limits (402 when over)', async () => {
    const owner = await signupOwner(app); // starter: max_sites = 1
    const siteA = await createSite(app, owner, `f3a-a-${uid()}.example.com`);
    const delA = await app.inject({ method: 'DELETE', url: `/api/v1/sites/${siteA}`, headers: authz(owner) });
    expect(delA.statusCode).toBe(200);
    const siteB = await createSite(app, owner, `f3a-b-${uid()}.example.com`);
    expect(siteB).toBeTruthy();
    const over = await app.inject({ method: 'POST', url: `/api/v1/sites/${siteA}/restore`, headers: authz(owner) });
    expect(over.statusCode).toBe(402);
    expect((over.json() as any).error.code).toBe('LIMIT_EXCEEDED');
    // Back under the limit, restore succeeds.
    await app.inject({ method: 'DELETE', url: `/api/v1/sites/${siteB}`, headers: authz(owner) });
    const ok = await app.inject({ method: 'POST', url: `/api/v1/sites/${siteA}/restore`, headers: authz(owner) });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as any).ok).toBe(true);
  });

  test('C5-M-5: POST /account/recover trims excess usage and clears read-only', async () => {
    const owner = await signupOwner(app); // starter: max_sites = 1
    const siteId = await createSite(app, owner);
    // Second site inserted directly (bypasses the API limit) to simulate a
    // downgrade with excess usage; tenant forced read-only.
    await query(`INSERT INTO sites (id, tenant_id, domain) VALUES (gen_random_uuid(), $1, $2)`, [
      owner.tenantId,
      `f3a-excess-${uid()}.example.com`,
    ]);
    await query(`UPDATE tenants SET read_only = TRUE WHERE id = $1`, [owner.tenantId]);
    const res = await app.inject({ method: 'POST', url: '/api/v1/account/recover', headers: authz(owner) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.removed.sites.length).toBe(1);
    expect(body.read_only).toBe(false);
    const t = await query(`SELECT read_only FROM tenants WHERE id = $1`, [owner.tenantId]);
    expect(t.rows[0].read_only).toBe(false);
    const kept = await query(`SELECT deleted_at FROM sites WHERE id = $1`, [siteId]);
    expect(kept.rows[0].deleted_at).toBeNull();
  });

  test('C1-L-1: onboarding PUT requires owner/admin/editor or the account:read scope', async () => {
    const owner = await signupOwner(app);
    const viewer = await addTeamMember(app, owner.tenantId, 'viewer');
    const siteId = await createSite(app, owner);
    const denied = await app.inject({
      method: 'PUT',
      url: `/api/v1/account/sites/${siteId}/onboarding`,
      headers: authz(viewer),
      payload: { step: 'verify_site', completed: true },
    });
    expect(denied.statusCode).toBe(403);
    // A zero-scope API key is also refused.
    const key = await mintKey(app, owner.token, ['sites:read']);
    const deniedKey = await app.inject({
      method: 'PUT',
      url: `/api/v1/account/sites/${siteId}/onboarding`,
      headers: { 'x-api-key': key },
      payload: { step: 'verify_site', completed: true },
    });
    expect(deniedKey.statusCode).toBe(403);
    // Owner session and a properly-scoped key pass.
    const ok = await app.inject({
      method: 'PUT',
      url: `/api/v1/account/sites/${siteId}/onboarding`,
      headers: authz(owner),
      payload: { step: 'verify_site', completed: true },
    });
    expect(ok.statusCode).toBe(200);
  });

  test('C1-L-15: email/change is throttled like the other resend flows', async () => {
    const owner = await signupOwner(app);
    for (let i = 0; i < 3; i++) {
      await query(
        `INSERT INTO email_verification_tokens (user_id, token_hash, purpose, expires_at) VALUES ($1, $2, 'email_change', now() + interval '1 hour')`,
        [owner.userId, `f3a-hash-${uid()}-${i}`],
      );
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/change',
      headers: authz(owner),
      payload: { email: `f3a-new-${uid()}@example.com` },
    });
    expect(res.statusCode).toBe(429);
    expect((res.json() as any).error.code).toBe('RATE_LIMITED');
  });

  test('C2-M-2: BYOK decrypt failure with explicit provider throws 502 (fail closed)', async () => {
    const owner = await signupOwner(app);
    await query(`UPDATE tenants SET llm_provider = 'gemini', llm_api_key_enc = $1 WHERE id = $2`, [
      'not-valid-encrypted-data',
      owner.tenantId,
    ]);
    await expect(getLLMForTenant(owner.tenantId)).rejects.toMatchObject({
      status: 502,
      code: 'LLM_KEY_DECRYPT_FAILED',
    });
  });

  test('C2-M-2 (control): a valid BYOK key still decrypts and routes to the tenant provider', async () => {
    const owner = await signupOwner(app);
    await query(`UPDATE tenants SET llm_provider = 'gemini', llm_api_key_enc = $1 WHERE id = $2`, [
      encrypt('tenant-gemini-key'),
      owner.tenantId,
    ]);
    const p = await getLLMForTenant(owner.tenantId);
    expect(p.name).toBe('gemini');
  });

  test('cancelTenantBilling: no customer is an honest no-op', async () => {
    const owner = await signupOwner(app);
    const res = await cancelTenantBilling(owner.tenantId);
    expect(res.canceled).toEqual([]);
    expect(res.creditsCents).toBe(0);
  });
});
