/**
 * Wave-4 Pass#6 fix worker A — F2-M-1 regression.
 *
 * The pass#5 trial-gate fix (E4-M-1) removed 'incomplete' from the
 * billable subscription statuses in middleware/requireSubscription.ts,
 * but the scheduler's two billing-liveness filters (enqueueForVerifiedSites
 * and the rank-checks query) still listed 'incomplete' — so trial-expired
 * tenants with never-funded checkouts kept getting rank-checks, crawls,
 * reports, geo and backlink sweeps. This test exercises the REAL enqueue
 * query logic of both schedules against a real test DB and asserts that an
 * 'incomplete'-status tenant is excluded while 'active'/'trialing'/
 * 'past_due'/live-trial tenants are still enqueued.
 *
 * Needs DATABASE_URL at a test database + Redis.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { pool, query, runMigrations } from '../../src/db.js';

// Mock the queue layer so no real BullMQ jobs are enqueued; the scheduler's
// SQL filtering logic still runs against the real test DB.
const calls = vi.hoisted(() => ({ enqueue: [] as Array<{ queue: string; job: string; siteId: string }> }));
vi.mock('../../src/queues.js', () => ({
  enqueue: (q: string, j: string, data: any) => {
    calls.enqueue.push({ queue: q, job: j, siteId: data.siteId });
    return Promise.resolve({ id: 'mock' });
  },
  QUEUES: {
    crawl: 'crawl',
    rankCheck: 'rank-check',
    keywordRefresh: 'keyword-refresh',
    geoCheck: 'geo-check',
    report: 'report',
  },
  Jobs: {
    RANK_CHECK: 'rank-check',
    WEEKLY_REPORT: 'weekly-report',
  },
}));

const { SCHEDULES } = await import('../../src/scheduler.js');

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

interface Fixture {
  key: string;
  tenantId: string;
  siteId: string;
}

describe.runIf(HAS_TEST_DB)('F2-M-1: scheduler excludes incomplete subscriptions from spend enqueue', () => {
  const fixtures: Fixture[] = [];
  const siteFor = (key: string) => fixtures.find((f) => f.key === key)!.siteId;
  const enqueuedSites = (jobName: string) =>
    calls.enqueue.filter((c) => c.job === jobName).map((c) => c.siteId);

  async function addTenant(
    key: string,
    opts: {
      trialLive: boolean;
      subStatus?: string;
      readOnly?: boolean;
      suspended?: boolean;
      verified?: boolean;
    },
  ): Promise<void> {
    const trial = opts.trialLive ? `now() + interval '1 day'` : `now() - interval '1 day'`;
    const t = await query(
      `INSERT INTO tenants (name, plan_id, trial_ends_at, read_only, suspended_at)
       VALUES ($1, 'pro', ${trial}, $2, ${opts.suspended ? `now()` : 'NULL'})
       RETURNING id`,
      [`f2m1-${key}`, opts.readOnly ?? false],
    );
    const tenantId = t.rows[0].id as string;
    if (opts.subStatus) {
      await query(
        `INSERT INTO subscriptions (tenant_id, plan_id, status, stripe_sub_id)
         VALUES ($1, 'pro', $2, 'sub_test_f2m1')`,
        [tenantId, opts.subStatus],
      );
    }
    const s = await query(
      `INSERT INTO sites (tenant_id, domain, verified) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, `${key}.f2m1.example`, opts.verified ?? true],
    );
    fixtures.push({ key, tenantId, siteId: s.rows[0].id as string });
  }

  beforeAll(async () => {
    await runMigrations();
    // F2-M-1 regression case: trial expired, subscription stuck in
    // 'incomplete' (never-funded checkout) — must get NO scheduled spend.
    await addTenant('incomplete', { trialLive: false, subStatus: 'incomplete' });
    // Still-billable controls.
    await addTenant('active', { trialLive: false, subStatus: 'active' });
    await addTenant('pastdue', { trialLive: false, subStatus: 'past_due' });
    await addTenant('trialing', { trialLive: false, subStatus: 'trialing' });
    await addTenant('livetrial', { trialLive: true });
    // Non-billable controls.
    await addTenant('nosub', { trialLive: false });
    await addTenant('readonly', { trialLive: false, subStatus: 'active', readOnly: true });
    await addTenant('suspended', { trialLive: false, subStatus: 'active', suspended: true });
    await addTenant('unverified', { trialLive: false, subStatus: 'active', verified: false });
    calls.enqueue.length = 0;
    const rankChecks = SCHEDULES.find((s) => s.name === 'rank-checks')!;
    await rankChecks.run();
    const weeklyReports = SCHEDULES.find((s) => s.name === 'weekly-reports')!;
    await weeklyReports.run();
  }, 60000);

  afterAll(async () => {
    const ids = fixtures.map((f) => f.tenantId);
    if (ids.length) await query('DELETE FROM tenants WHERE id = ANY($1)', [ids]);
    await pool.end();
  });

  describe('rank-checks schedule (its own billing-liveness query)', () => {
    it("excludes the trial-expired tenant whose subscription is 'incomplete'", () => {
      expect(enqueuedSites('rank-check')).not.toContain(siteFor('incomplete'));
    });
    it("still enqueues 'active'/'trialing'/'past_due' and live-trial tenants", () => {
      const got = enqueuedSites('rank-check');
      for (const k of ['active', 'pastdue', 'trialing', 'livetrial']) {
        expect(got, k).toContain(siteFor(k));
      }
    });
    it('still excludes expired-trial/no-subscription, read-only, suspended and unverified sites', () => {
      const got = enqueuedSites('rank-check');
      for (const k of ['nosub', 'readonly', 'suspended', 'unverified']) {
        expect(got, k).not.toContain(siteFor(k));
      }
    });
  });

  describe('weekly-reports schedule (enqueueForVerifiedSites query)', () => {
    it("excludes the trial-expired tenant whose subscription is 'incomplete'", () => {
      expect(enqueuedSites('weekly-report')).not.toContain(siteFor('incomplete'));
    });
    it("still enqueues 'active'/'trialing'/'past_due' and live-trial tenants", () => {
      const got = enqueuedSites('weekly-report');
      for (const k of ['active', 'pastdue', 'trialing', 'livetrial']) {
        expect(got, k).toContain(siteFor(k));
      }
    });
    it('still excludes expired-trial/no-subscription, read-only, suspended and unverified sites', () => {
      const got = enqueuedSites('weekly-report');
      for (const k of ['nosub', 'readonly', 'suspended', 'unverified']) {
        expect(got, k).not.toContain(siteFor(k));
      }
    });
  });
});
