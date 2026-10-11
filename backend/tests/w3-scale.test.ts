// W-01: worker queue classes, per-tenant fairness, global provider-spend circuit.
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { pool, query, runMigrations } from '../src/db.js';
import { signupVerified, tenantCollector, auth } from './helpers-ba.js';
import { QUEUE_CLASS, pickNextTenantFairly, acquireHeavySlot, releaseHeavySlot, HEAVY_CONCURRENCY_PER_TENANT } from '../src/services/fairness.js';
import { queueConcurrency } from '../src/worker.js';
import { assertGlobalProviderBudget, getGlobalDailySpend, globalCapsFromEnv } from '../src/services/providerGuard.js';
import { QUEUES } from '../src/queues.js';

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

describe.runIf(HAS_TEST_DB)('W-01 scale', () => {
  let app: FastifyInstance;
  const tc = tenantCollector();
  beforeAll(async () => {
    await runMigrations();
    app = await buildApp();
  }, 60000);
  afterAll(async () => {
    await app?.close();
    if (tc.ids.length) await query('DELETE FROM tenants WHERE id = ANY($1)', [tc.ids]);
    await pool.end();
  });

  it('queue classes: crawl heavy, everything else light', () => {
    expect(QUEUE_CLASS[QUEUES.crawl]).toBe('heavy');
    expect(QUEUE_CLASS[QUEUES.rankCheck]).toBe('light');
    expect(QUEUE_CLASS[QUEUES.report]).toBe('light');
    expect(queueConcurrency(QUEUES.crawl, { WORKER_HEAVY_CONCURRENCY: '6', WORKER_LIGHT_CONCURRENCY: '3' } as any)).toBe(6);
    expect(queueConcurrency(QUEUES.geoCheck, { WORKER_HEAVY_CONCURRENCY: '6', WORKER_LIGHT_CONCURRENCY: '3' } as any)).toBe(3);
  });

  it('per-tenant heavy slots: 2 concurrent, 3rd denied (fairness proof)', async () => {
    const tid = `fair-${Date.now()}`;
    const a = await acquireHeavySlot(tid);
    const b = await acquireHeavySlot(tid);
    const c = await acquireHeavySlot(tid);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).toBeNull(); // fairness: one tenant cannot hog heavy slots
    expect(HEAVY_CONCURRENCY_PER_TENANT).toBe(2);
    if (a) await releaseHeavySlot(tid, a);
    if (b) await releaseHeavySlot(tid, b);
    const d = await acquireHeavySlot(tid); // released -> acquirable again
    expect(d).not.toBeNull();
    if (d) await releaseHeavySlot(tid, d);
  });

  it('pickNextTenantFairly skips tenants at their limit', () => {
    expect(pickNextTenantFairly(['t1', 't2'], new Set(['t1']))).toBe('t2');
    expect(pickNextTenantFairly(['t1'], new Set(['t1']))).toBeNull();
  });

  it('global provider budget: disabled by default; 503 when the daily cap is tripped', async () => {
    expect(globalCapsFromEnv({} as any)).toEqual({ capCents: 0, capUnits: 0 });
    await assertGlobalProviderBudget(); // no throw when disabled
    const u = await signupVerified(app); tc.add(u.tenantId);
    await query(`INSERT INTO provider_spend (id,tenant_id,provider,feature,units,cost_cents) VALUES (gen_random_uuid(),$1,'dataforseo','serp',5,0)`, [u.tenantId]);
    const spend = await getGlobalDailySpend();
    expect(spend.units).toBeGreaterThanOrEqual(5);
    process.env.GLOBAL_PROVIDER_DAILY_CAP_UNITS = '5';
    try {
      await expect(assertGlobalProviderBudget()).rejects.toMatchObject({ status: 503, code: 'PROVIDER_BUDGET_EXCEEDED' });
    } finally {
      delete process.env.GLOBAL_PROVIDER_DAILY_CAP_UNITS;
    }
  });

  it('keyword cache miss is blocked when the global circuit is open', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    const { getKeywordMetrics } = await import('../src/services/keywordCache.js');
    class Boom { name = 'boom'; isMock = false; async keywordMetrics(): Promise<never[]> { throw new Error('should not be called'); } async serp() { throw new Error('x'); } }
    process.env.GLOBAL_PROVIDER_DAILY_CAP_UNITS = '1';
    try {
      await query(`INSERT INTO provider_spend (id,tenant_id,provider,feature,units,cost_cents) VALUES (gen_random_uuid(),$1,'dataforseo','serp',3,0)`, [u.tenantId]);
      await expect(getKeywordMetrics(u.tenantId, [`w3guard-${Date.now()}`], query, Boom as any)).rejects.toMatchObject({ code: 'PROVIDER_BUDGET_EXCEEDED' });
    } finally {
      delete process.env.GLOBAL_PROVIDER_DAILY_CAP_UNITS;
    }
  });
});
