import cron, { type ScheduledTask } from 'node-cron';
import { query } from './db.js';
import { enqueue, QUEUES, Jobs } from './queues.js';
import { getPlan } from './plans.js';
import { createLeaderElection } from './services/leaderElection.js';
import { processBillingGrace } from './services/billing.js';
import { runRetentionCleanup } from './services/retention.js';

/**
 * ISO week key, computed with UTC getters ONLY (N-A2-2). The old version
 * mixed local date parts into Date.UTC(), producing the wrong week key near
 * midnight for non-UTC server timezones and breaking the idempotency
 * dedupe that relies on it.
 */
export function isoWeek(d = new Date()): string {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// One leader-election gate shared by every tick (N-A2-2): N worker
// processes each run the scheduler, but exactly one tick executes.
const leader = createLeaderElection('scheduler:leader', 30_000);

async function onlyLeader<T>(work: () => Promise<T>): Promise<T | null> {
  if (!(await leader.tryAcquire())) return null;
  return work();
}

async function enqueueForVerifiedSites(
  queue: string,
  jobName: string,
  keyPrefix: (siteId: string) => string,
  extra: (siteId: string, tenantId: string) => Record<string, unknown> = () => ({}),
) {
  // Scheduler bulk-enqueues are system-initiated: they bypass the
  // per-tenant enqueue rate limiter (user-initiated API enqueues keep it).
  const r = await query(`SELECT id, tenant_id FROM sites WHERE verified = TRUE AND deleted_at IS NULL`);
  for (const s of r.rows) {
    await enqueue(
      queue,
      jobName,
      { siteId: s.id, tenantId: s.tenant_id, ...extra(s.id, s.tenant_id) },
      { idempotencyKey: keyPrefix(s.id), rateLimit: false },
    );
  }
}

export interface ScheduleDef {
  name: string;
  cron: string;
  run: () => Promise<void>;
}

/**
 * All recurring work, data-driven so tests can assert UTC/timezone
 * consistency (C-03). Every schedule runs in UTC; every tick is
 * leader-gated so N workers produce exactly one tick.
 */
export const SCHEDULES: ScheduleDef[] = [
  {
    name: 'weekly-crawl',
    cron: '0 2 * * 0', // Sundays 02:00 UTC
    run: () => enqueueForVerifiedSites(QUEUES.crawl, Jobs.CRAWL_SITE, (id) => `crawl:${id}:${isoWeek()}`),
  },
  {
    name: 'rank-checks',
    cron: '0 3 * * *', // daily 03:00 UTC; weekly-plan sites only on Sunday
    run: async () => {
      const isSunday = new Date().getUTCDay() === 0;
      const r = await query(
        `SELECT s.id AS site_id, s.tenant_id, t.plan_id
         FROM sites s JOIN tenants t ON t.id = s.tenant_id
         WHERE s.verified = TRUE AND s.deleted_at IS NULL`,
      );
      for (const row of r.rows) {
        const freq = getPlan(row.plan_id).rankcheck_freq;
        if (freq === 'daily' || (freq === 'weekly' && isSunday)) {
          await enqueue(
            QUEUES.rankCheck,
            Jobs.RANK_CHECK,
            { siteId: row.site_id, tenantId: row.tenant_id },
            { idempotencyKey: `rank:${row.site_id}:${new Date().toISOString().slice(0, 10)}`, rateLimit: false },
          );
        }
      }
    },
  },
  {
    name: 'weekly-reports',
    cron: '0 8 * * 1', // Mondays 08:00 UTC
    run: () => enqueueForVerifiedSites(QUEUES.report, Jobs.WEEKLY_REPORT, (id) => `report:${id}:${isoWeek()}`),
  },
  {
    name: 'daily-light-check',
    cron: '0 6 * * *', // 06:00 UTC — catches sudden breakage between crawls
    run: () =>
      enqueueForVerifiedSites(
        QUEUES.crawl,
        Jobs.LIGHT_CHECK,
        (id) => `light:${id}:${new Date().toISOString().slice(0, 10)}`,
      ),
  },
  {
    name: 'monthly-keyword-refresh',
    cron: '0 4 1 * *', // 1st of month 04:00 UTC
    run: () =>
      enqueueForVerifiedSites(
        QUEUES.keywordRefresh,
        Jobs.KEYWORD_REFRESH,
        (id) => `kwrefresh:${id}:${new Date().toISOString().slice(0, 7)}`,
      ),
  },
  {
    name: 'weekly-geo-checks',
    cron: '0 5 * * 3', // Wednesdays 05:00 UTC
    run: () => enqueueForVerifiedSites(QUEUES.geoCheck, Jobs.GEO_CHECK, (id) => `geo:${id}:${isoWeek()}`),
  },
  {
    name: 'weekly-backlink-sweep',
    cron: '0 6 * * 4', // Thursdays 06:00 UTC
    run: () => enqueueForVerifiedSites(QUEUES.crawl, Jobs.BACKLINK_REFRESH, (id) => `blsweep:${id}:${isoWeek()}`),
  },
  {
    name: 'weekly-domain-reverify',
    cron: '30 4 * * 6', // Saturdays 04:30 UTC (S-08)
    run: () => enqueueForVerifiedSites(QUEUES.crawl, Jobs.REVERIFY_SITE, (id) => `reverify:${id}:${isoWeek()}`),
  },
  {
    name: 'billing-grace',
    cron: '0 1 * * *', // daily 01:00 UTC — downgrade past_due tenants whose grace expired (C-01)
    run: async () => {
      const n = await processBillingGrace();
      if (n > 0) console.log(`[scheduler] billing grace: downgraded ${n} tenant(s)`);
    },
  },
  {
    name: 'retention-cleanup',
    cron: '0 4 * * *', // daily 04:00 UTC (C-06)
    run: async () => {
      const results = await runRetentionCleanup();
      const total = results.reduce((a, r) => a + r.deleted, 0);
      if (total > 0) console.log(`[scheduler] retention cleanup: deleted ${total} row(s)`, results);
    },
  },
];

/** All cron schedules evaluate in UTC (C-03: "cron uses UTC consistently"). */
export const SCHEDULER_TIMEZONE = 'UTC' as const;

/** Enqueues all recurring work. Idempotent jobIds make overlaps safe. */
export function startScheduler(): ScheduledTask[] {
  const tasks = SCHEDULES.map((s) =>
    cron.schedule(
      s.cron,
      () =>
        void onlyLeader(s.run).catch((err) => {
          console.error(`[scheduler] job ${s.name} failed:`, err);
        }),
      { timezone: SCHEDULER_TIMEZONE },
    ),
  );
  console.log(`[scheduler] ${tasks.length} cron schedules registered (UTC, leader-elected)`);
  return tasks;
}

/** Stops all schedules (graceful shutdown, C-03). */
export function stopScheduler(tasks: ScheduledTask[]): void {
  for (const t of tasks) t.stop();
  console.log('[scheduler] stopped');
}
