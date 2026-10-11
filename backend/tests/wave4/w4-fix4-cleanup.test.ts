/**
 * Wave-4 Pass#4 cleanup regression tests (LA).
 * D5-L-2 (admin suspend pauses Stripe), D5-L-3 (atomic global reserve),
 * D1-M-2 (soft-delete re-add), D1-M-3 (batched rescore), D1-M-4 (TTL scaling).
 */
import { it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, query, authz, signupOwner, createSite } from './helpers.js';
import { resetDb } from '../integration/helpers/db.js';
import { reserveGlobalProviderBudget, commitGlobalProviderSpend, releaseGlobalProviderSpend, getGlobalDailySpend } from '../../src/services/providerGuard.js';
import { reserveUsage } from '../../src/metering.js';
import { rescoreToxicLinks } from '../../src/services/toxicLinks.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildTestApp();
  await resetDb();
  // Migration 045 tables (test DB may predate them if migrated before).
  await query(`CREATE TABLE IF NOT EXISTS global_provider_guard (day DATE PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
});
afterAll(async () => { await app.close(); });

it('D5-L-2: suspend pauses the mock subscription, unsuspend resumes it', async () => {
  const admin = await signupOwner(app);
  await query(`UPDATE users SET is_platform_admin = TRUE WHERE id = $1`, [admin.userId]);
  const owner = await signupOwner(app);
  // Give the tenant a mock subscription row.
  await query(
    `INSERT INTO subscriptions (tenant_id, stripe_customer_id, stripe_sub_id, plan_id, status)
     VALUES ($1, $2, $3, 'starter', 'active')`,
    [owner.tenantId, 'cus_test_suspend', 'sub_test_suspend'],
  );
  await query(`UPDATE tenants SET stripe_customer_id = 'cus_test_suspend' WHERE id = $1`, [owner.tenantId]);

  const susp = await app.inject({
    method: 'POST', url: `/api/v1/admin/tenants/${owner.tenantId}/suspend`,
    headers: authz(admin), payload: { reason: 'test' },
  });
  expect(susp.statusCode).toBe(200);
  expect((susp.json() as any).billingPaused).toContain('sub_test_suspend');
  const paused = await query(`SELECT status FROM subscriptions WHERE stripe_sub_id = 'sub_test_suspend'`);
  expect(paused.rows[0].status).toBe('paused');

  const unsusp = await app.inject({
    method: 'POST', url: `/api/v1/admin/tenants/${owner.tenantId}/unsuspend`,
    headers: authz(admin),
  });
  expect(unsusp.statusCode).toBe(200);
  expect((unsusp.json() as any).billingResumed).toContain('sub_test_suspend');
  const resumed = await query(`SELECT status FROM subscriptions WHERE stripe_sub_id = 'sub_test_suspend'`);
  expect(resumed.rows[0].status).toBe('active');
});

it('D5-L-3: global reserve enforces the cap atomically', async () => {
  process.env.GLOBAL_PROVIDER_DAILY_CAP_UNITS = '5';
  const u1 = await signupOwner(app);
  const u2 = await signupOwner(app);
  try {
    const r1 = await reserveGlobalProviderBudget(u1.tenantId, 'dataforseo', 'serp', 3);
    expect(r1.reservationId).toBeTruthy();
    // 3 + 3 > 5 -> 503
    await expect(reserveGlobalProviderBudget(u2.tenantId, 'dataforseo', 'serp', 3)).rejects.toMatchObject({
      status: 503,
    });
    // Release the first reservation, then the second fits.
    await releaseGlobalProviderSpend(r1.reservationId);
    const r2 = await reserveGlobalProviderBudget(u2.tenantId, 'dataforseo', 'serp', 3);
    await commitGlobalProviderSpend(r2.reservationId, 3, 1);
    const spend = await getGlobalDailySpend();
    expect(spend.units).toBe(3);
  } finally {
    delete process.env.GLOBAL_PROVIDER_DAILY_CAP_UNITS;
    await query(`DELETE FROM provider_spend`);
    await query(`DELETE FROM global_provider_guard`);
  }
});

it('D1-M-2: re-adding a soft-deleted domain restores instead of 409', async () => {
  const owner = await signupOwner(app);
  const siteId = await createSite(app, owner, 'restorable.example');
  // Soft-delete via the API.
  const del = await app.inject({ method: 'DELETE', url: `/api/v1/sites/${siteId}`, headers: authz(owner) });
  expect([200, 204]).toContain(del.statusCode);
  // Re-add the same domain -> 200 restored, not 409.
  const re = await app.inject({
    method: 'POST', url: '/api/v1/sites',
    headers: authz(owner), payload: { domain: 'restorable.example' },
  });
  expect(re.statusCode).toBe(200);
  expect((re.json() as any).restored).toBe(true);
  expect((re.json() as any).value.id).toBe(siteId);
  // And it shows up in the list again.
  const list = await app.inject({ method: 'GET', url: '/api/v1/sites', headers: authz(owner) });
  expect((list.json() as any).data.map((s: any) => s.domain)).toContain('restorable.example');
});

it('D1-M-3: batched rescore writes correct scores', async () => {
  const owner = await signupOwner(app);
  const siteId = await createSite(app, owner, 'toxic.example');
  await query(
    `INSERT INTO backlinks (tenant_id, site_id, source_url, target_url, anchor_text, status)
     VALUES ($1, $2, 'https://spam-casino-xxx.example/', 'https://toxic.example/', 'cheap viagra pills', 'active'),
            ($1, $2, 'https://reputable.example/article', 'https://toxic.example/', 'helpful guide', 'active')`,
    [owner.tenantId, siteId],
  );
  const res = await rescoreToxicLinks(owner.tenantId, siteId, 'toxic.example', query);
  expect(res.rescored).toBe(2);
  const rows = await query(
    `SELECT source_url, toxic_score, referring_domain FROM backlinks WHERE site_id = $1 ORDER BY source_url`,
    [siteId],
  );
  expect(rows.rows.length).toBe(2);
  const spam = rows.rows.find((r: any) => r.source_url.includes('spam-casino'));
  const legit = rows.rows.find((r: any) => r.source_url.includes('reputable'));
  expect(spam.toxic_score).toBeGreaterThan(legit.toxic_score);
  expect(spam.referring_domain).toBe('spam-casino-xxx.example');
  expect(legit.referring_domain).toBe('reputable.example');
});

it('D1-M-4: reservation TTL scales with ttlMinutes', async () => {
  const owner = await signupOwner(app);
  const rsv = await reserveUsage(owner.tenantId, 'starter', 'crawl_pages', 10, { ttlMinutes: 120 });
  const row = await query(`SELECT expires_at FROM usage_reservations WHERE id = $1`, [rsv.reservationId]);
  const mins = (new Date(row.rows[0].expires_at).getTime() - Date.now()) / 60000;
  expect(mins).toBeGreaterThan(110);
  expect(mins).toBeLessThan(125);
  // Default is still ~15 minutes.
  const rsv2 = await reserveUsage(owner.tenantId, 'starter', 'crawl_pages', 10, {});
  const row2 = await query(`SELECT expires_at FROM usage_reservations WHERE id = $1`, [rsv2.reservationId]);
  const mins2 = (new Date(row2.rows[0].expires_at).getTime() - Date.now()) / 60000;
  expect(mins2).toBeGreaterThan(10);
  expect(mins2).toBeLessThan(20);
});
