/**
 * Wave-4 Pass #1 MEDIUM regression tests — batch 2 (backend).
 *
 * A1-M4: sendSlack routes through safeFetch (no raw fetch).
 * A1-M5: admin plan override recomputes read_only + syncs subscriptions.
 * A1-M6: client trialDays rejected; trial length is server-side.
 * A1-M7: admin tenant detail: explicit columns, never llm_api_key_enc.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildTestApp, query, signupOwner, authz } from './helpers.js';

vi.mock('../../src/services/safeFetch.js', () => ({
  safeFetch: vi.fn(async () => ({ ok: true, status: 200 })),
}));

import { safeFetch } from '../../src/services/safeFetch.js';
import { sendSlack } from '../../src/services/notifications.js';

let app: Awaited<ReturnType<typeof buildTestApp>>;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('A1-M4: sendSlack via safeFetch', () => {
  it('delivers through safeFetch, never raw fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const mocked = vi.mocked(safeFetch);
    mocked.mockClear();
    await sendSlack('https://hooks.slack.com/services/T/TEST/WEBHOOK', {
      title: 'W4 test',
      body: 'hello',
    } as any);
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0][0]).toBe('https://hooks.slack.com/services/T/TEST/WEBHOOK');
    expect(mocked.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    // The old code path (validate-then-raw-fetch) must not be used.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

/** Promote a signed-up owner to platform admin. */
async function makePlatformAdmin(app: any, user: { userId: string }) {
  await query(`UPDATE users SET is_platform_admin = TRUE WHERE id = $1`, [user.userId]);
}

describe('A1-M5: admin plan override', () => {
  it('recomputes read_only and syncs the subscriptions row', async () => {
    const admin = await signupOwner(app);
    await makePlatformAdmin(app, admin);
    const target = await signupOwner(app);
    // Simulate a tenant stuck read-only from a past downgrade with a
    // stale canceled subscription row.
    await query(`UPDATE tenants SET read_only = TRUE WHERE id = $1`, [target.tenantId]);
    await query(
      `INSERT INTO subscriptions (id, tenant_id, plan_id, status, current_period_start, current_period_end)
       VALUES (gen_random_uuid(), $1, 'starter', 'canceled', now() - interval '40 days', now() - interval '10 days')`,
      [target.tenantId],
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/tenants/${target.tenantId}/plan`,
      headers: authz(admin),
      payload: { planId: 'growth', reason: 'wave4 regression test' },
    });
    expect(res.statusCode).toBe(200);
    const t = await query(`SELECT plan_id, read_only FROM tenants WHERE id = $1`, [target.tenantId]);
    expect(t.rows[0].plan_id).toBe('growth');
    // Tenant has 0 sites; growth allows 3 -> read_only recomputed to false.
    expect(t.rows[0].read_only).toBe(false);
    const sub = await query(
      `SELECT status, plan_id, stripe_sub_id, grace_until FROM subscriptions WHERE tenant_id = $1`,
      [target.tenantId],
    );
    expect(sub.rows[0].status).toBe('active');
    expect(sub.rows[0].plan_id).toBe('growth');
    expect(sub.rows[0].stripe_sub_id).toBeNull();
    expect(sub.rows[0].grace_until).toBeNull();
  });
});

describe('A1-M6: server-side trial length', () => {
  it('ignores client-supplied trialDays: no trial granted end-to-end', async () => {
    const owner = await signupOwner(app);
    const checkout = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: authz(owner),
      payload: { planId: 'growth', interval: 'monthly', trialDays: 90 },
    });
    expect(checkout.statusCode).toBe(200);
    const url = new URL((checkout.json() as any).url);
    // The hostile trialDays must not ride along into the session metadata.
    expect(url.searchParams.get('trial_days')).toBeNull();
    // Even a tampered mock-confirm querystring grants no trial (server-side).
    const tampered = `${url.pathname}${url.search}&trial_days=90`;
    const confirm = await app.inject({ method: 'GET', url: tampered, headers: authz(owner) });
    expect(confirm.statusCode).toBe(302);
    const sub = await query(
      `SELECT status, trial_ends_at FROM subscriptions WHERE tenant_id = $1`,
      [owner.tenantId],
    );
    expect(sub.rows.length).toBe(1);
    expect(sub.rows[0].status).toBe('active'); // not 'trialing'
    expect(sub.rows[0].trial_ends_at).toBeNull();
  });

  it('plan trial_days is server-side (0 by default)', async () => {
    const { getPlan } = await import('../../src/plans.js');
    for (const planId of ['starter', 'growth', 'scale'] as const) {
      expect(getPlan(planId).trial_days).toBe(0);
    }
  });
});

describe('A1-M7: admin tenant detail', () => {
  it('exposes llm_key_set boolean, never llm_api_key_enc', async () => {
    const admin = await signupOwner(app);
    await makePlatformAdmin(app, admin);
    const target = await signupOwner(app);
    // Give the target a BYOK key so the boolean is exercised as true.
    await query(`UPDATE tenants SET llm_api_key_enc = 'enc:dummy' WHERE id = $1`, [target.tenantId]);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/tenants/${target.tenantId}`,
      headers: authz(admin),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('llm_api_key_enc');
    expect(body.llm_key_set).toBe(true);
  });
});
