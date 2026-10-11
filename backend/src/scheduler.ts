import cron, { type ScheduledTask } from 'node-cron';
import { query } from './db.js';
import { enqueue, QUEUES, Jobs } from './queues.js';
import { getPlan } from './plans.js';
import { createLeaderElection } from './services/leaderElection.js';
import { processBillingGrace } from './services/billing.js';
import { runRetentionCleanup } from './services/retention.js';
import { processWebhookRetries } from './services/webhookDelivery.js';
import { processDigests } from './services/notifications.js';
import { isoWeek } from './weekKey.js';

// B1-8: the canonical ISO-week helper lives in weekKey.ts (side-effect
// free); re-exported here so existing `scheduler.js` imports keep working.
export { isoWeek };

// One leader-election gate shared by every tick (N-A2-2): N worker
// processes each run the scheduler, but exactly one tick executes.
const leader = createLeaderElection('scheduler:leader', 30_000);

async function onlyLeader<T>(work: () => Promise<T>): Promise<T | null> {
  if (!(await leader.tryAcquire())) return null;
  // A2-M4: a tick that runs longer than the 30s lock TTL (large digest /
  // webhook-retry batches, slow enqueue loops) must not lose leadership
  // mid-tick and let a second worker run the same schedule. Heartbeat
  // until the work settles. (The consumers below ALSO claim-then-work
  // atomically, so even a lost lock can't double-execute.)
  const hb = setInterval(() => {
    void leader.heartbeat().then((ok) => {
      if (!ok) console.warn('[scheduler] leader lock lost mid-tick');
    });
  }, 10_000);
  hb.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(hb);
  }
}

async function enqueueForVerifiedSites(
  queue: string,
  jobName: string,
  keyPrefix: (siteId: string) => string,
  extra: (siteId: string, tenantId: string) => Record<string, unknown> = () => ({}),
) {
  // Scheduler bulk-enqueues are system-initiated: they bypass the
  // per-tenant enqueue rate limiter (user-initiated API enqueues keep it).
  // E4-H-1: filter by billing liveness — trial-expired tenants with no live
  // subscription, and suspended tenants, must NOT get scheduled spend jobs.
  // (The route-layer trial gate can't cover system-initiated work.)
  // F2-M-1: 'incomplete' is NOT billable here — this list must match
  // BILLABLE_SUBSCRIPTION_STATUSES in middleware/requireSubscription.ts
  // (E4-M-1). An 'incomplete' subscription means the first payment never
  // succeeded; counting it as live would reopen the rolling free-access
  // loop (never-funded checkouts keep getting scheduled spend). The
  // scheduler enrollment is a spend decision, not dunning — 'incomplete'
  // correctly stays in the dunning/grace logic (services/billing.ts).
  const r = await query(
    `SELECT s.id, s.tenant_id FROM sites s
     JOIN tenants t ON t.id = s.tenant_id
     LEFT JOIN subscriptions sub ON sub.tenant_id = t.id
     WHERE s.verified = TRUE AND s.deleted_at IS NULL
       AND t.suspended_at IS NULL
       AND t.read_only = FALSE
       AND (t.trial_ends_at IS NULL
            OR t.trial_ends_at > now()
            OR sub.status IN ('active', 'trialing', 'past_due'))`,
  );
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
    // C2-L6: one week key per tick — a tick spanning a UTC midnight must not
    // give sites different idempotency keys.
    run: () => {
      const week = isoWeek();
      return enqueueForVerifiedSites(QUEUES.crawl, Jobs.CRAWL_SITE, (id) => `crawl:${id}:${week}`);
    },
  },
  {
    name: 'rank-checks',
    cron: '0 3 * * *', // daily 03:00 UTC; weekly-plan sites only on Sunday
    run: async () => {
      // C2-L6: compute the idempotency date key ONCE per tick. Building it
      // per row inside the loop meant a tick spanning a UTC midnight gave
      // sites different date keys and could enqueue the same site twice
      // for two "days".
      const today = new Date().toISOString().slice(0, 10);
      const isSunday = new Date().getUTCDay() === 0;
      const r = await query(
        `SELECT s.id AS site_id, s.tenant_id, t.plan_id
         FROM sites s JOIN tenants t ON t.id = s.tenant_id
         LEFT JOIN subscriptions sub ON sub.tenant_id = t.id
         WHERE s.verified = TRUE AND s.deleted_at IS NULL
           AND t.suspended_at IS NULL
           AND t.read_only = FALSE
           AND (t.trial_ends_at IS NULL
                OR t.trial_ends_at > now()
                OR sub.status IN ('active', 'trialing', 'past_due'))`,
      );
      for (const row of r.rows) {
        const freq = getPlan(row.plan_id).rankcheck_freq;
        if (freq === 'daily' || (freq === 'weekly' && isSunday)) {
          await enqueue(
            QUEUES.rankCheck,
            Jobs.RANK_CHECK,
            { siteId: row.site_id, tenantId: row.tenant_id },
            { idempotencyKey: `rank:${row.site_id}:${today}`, rateLimit: false },
          );
        }
      }
    },
  },
  {
    name: 'weekly-reports',
    cron: '0 8 * * 1', // Mondays 08:00 UTC
    run: () => {
      const week = isoWeek(); // C2-L6: one key per tick
      return enqueueForVerifiedSites(QUEUES.report, Jobs.WEEKLY_REPORT, (id) => `report:${id}:${week}`);
    },
  },
  {
    name: 'daily-light-check',
    cron: '0 6 * * *', // 06:00 UTC — catches sudden breakage between crawls
    // C2-L6: one date key per tick (same midnight-split class as rank-checks).
    run: () => {
      const today = new Date().toISOString().slice(0, 10);
      return enqueueForVerifiedSites(
        QUEUES.crawl,
        Jobs.LIGHT_CHECK,
        (id) => `light:${id}:${today}`,
      );
    },
  },
  {
    name: 'monthly-keyword-refresh',
    cron: '0 4 1 * *', // 1st of month 04:00 UTC
    // C2-L6: one month key per tick.
    run: () => {
      const month = new Date().toISOString().slice(0, 7);
      return enqueueForVerifiedSites(
        QUEUES.keywordRefresh,
        Jobs.KEYWORD_REFRESH,
        (id) => `kwrefresh:${id}:${month}`,
      );
    },
  },
  {
    name: 'weekly-geo-checks',
    cron: '0 5 * * 3', // Wednesdays 05:00 UTC
    run: () => {
      const week = isoWeek(); // C2-L6: one key per tick
      return enqueueForVerifiedSites(QUEUES.geoCheck, Jobs.GEO_CHECK, (id) => `geo:${id}:${week}`);
    },
  },
  {
    name: 'weekly-backlink-sweep',
    cron: '0 6 * * 4', // Thursdays 06:00 UTC
    run: () => {
      const week = isoWeek(); // C2-L6: one key per tick
      return enqueueForVerifiedSites(QUEUES.crawl, Jobs.BACKLINK_REFRESH, (id) => `blsweep:${id}:${week}`);
    },
  },
  {
    name: 'weekly-domain-reverify',
    cron: '30 4 * * 6', // Saturdays 04:30 UTC (S-08)
    run: () => {
      const week = isoWeek(); // C2-L6: one key per tick
      return enqueueForVerifiedSites(QUEUES.crawl, Jobs.REVERIFY_SITE, (id) => `reverify:${id}:${week}`);
    },
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
  {
    name: 'webhook-retries',
    cron: '*/5 * * * *', // every 5 min — signed webhook delivery retries (F-10)
    run: async () => {
      const n = await processWebhookRetries();
      if (n > 0) console.log(`[scheduler] webhook retries: attempted ${n} deliverie(s)`);
    },
  },
  {
    name: 'notification-digests',
    cron: '0 7 * * *', // daily 07:00 UTC — due digest emails (F-10)
    run: async () => {
      const n = await processDigests();
      if (n > 0) console.log(`[scheduler] digests: processed ${n} user(s)`);
    },
  },
  {
    name: 'stuck-audit-reaper',
    cron: '*/15 * * * *', // every 15 min — reap orphan 'queued' audits (B1-5)
    run: async () => {
      const n = await reapStuckAudits();
      if (n > 0) console.log(`[scheduler] stuck-audit-reaper: marked ${n} audit(s) failed`);
    },
  },
];

/** All cron schedules evaluate in UTC (C-03: "cron uses UTC consistently"). */
export const SCHEDULER_TIMEZONE = 'UTC' as const;

/**
 * B1-5: reaps audits stuck in 'queued'. The worker picks up queued audits
 * within seconds of enqueue, so a row still 'queued' after 2h is an orphan
 * (crash between the INSERT and the enqueue-failure marking, or between
 * enqueue and the worker's claim). Without this, the row 409s every future
 * audit for the site forever AND the audits_one_active_per_site partial
 * unique index blocks worker recovery inserts. Same 2h predicate as
 * migration 041's one-time cleanup; 'running' rows are left alone — the
 * worker owns their lifecycle. Exported for tests.
 */
export async function reapStuckAudits(): Promise<number> {
  const r = await query(
    `UPDATE audits SET status = 'failed', finished_at = now(),
            error = 'stale queued audit reaped by scheduler (older than 2h)'
     WHERE status = 'queued' AND started_at < now() - interval '2 hours'`,
  );
  return r.rowCount ?? 0;
}

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
