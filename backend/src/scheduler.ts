import cron from 'node-cron';
import { query } from './db.js';
import { enqueue, QUEUES, Jobs } from './queues.js';
import { getPlan } from './plans.js';

function isoWeek(d = new Date()): string {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Enqueues all recurring work. Idempotent jobIds make overlaps safe. */
export function startScheduler() {
  // Weekly full crawl for every verified site — Sundays 02:00 UTC
  cron.schedule('0 2 * * 0', async () => {
    const r = await query(`SELECT id, tenant_id FROM sites WHERE verified = TRUE`);
    for (const s of r.rows) {
      await enqueue(QUEUES.crawl, Jobs.CRAWL_SITE,
        { siteId: s.id, tenantId: s.tenant_id },
        { idempotencyKey: `crawl:${s.id}:${isoWeek()}` });
    }
  });

  // Rank checks per plan frequency — daily 03:00 UTC; weekly-plan sites only on Sunday
  cron.schedule('0 3 * * *', async () => {
    const isSunday = new Date().getUTCDay() === 0;
    const r = await query(
      `SELECT s.id AS site_id, s.tenant_id, t.plan_id
       FROM sites s JOIN tenants t ON t.id = s.tenant_id WHERE s.verified = TRUE`);
    for (const row of r.rows) {
      const freq = getPlan(row.plan_id).rankcheck_freq;
      if (freq === 'daily' || (freq === 'weekly' && isSunday)) {
        await enqueue(QUEUES.rankCheck, Jobs.RANK_CHECK,
          { siteId: row.site_id, tenantId: row.tenant_id },
          { idempotencyKey: `rank:${row.site_id}:${new Date().toISOString().slice(0, 10)}` });
      }
    }
  });

  // Weekly reports — Mondays 08:00 UTC
  cron.schedule('0 8 * * 1', async () => {
    const r = await query(`SELECT id, tenant_id FROM sites WHERE verified = TRUE`);
    for (const s of r.rows) {
      await enqueue(QUEUES.report, Jobs.WEEKLY_REPORT,
        { siteId: s.id, tenantId: s.tenant_id },
        { idempotencyKey: `report:${s.id}:${isoWeek()}` });
    }
  });

  // Daily light check (homepage only) for verified sites — 06:00 UTC.
  // Catches sudden breakage (site down, noindex added) between weekly crawls.
  cron.schedule('0 6 * * *', async () => {
    const r = await query(`SELECT id, tenant_id FROM sites WHERE verified = TRUE`);
    for (const s of r.rows) {
      await enqueue(QUEUES.crawl, Jobs.LIGHT_CHECK,
        { siteId: s.id, tenantId: s.tenant_id },
        { idempotencyKey: `light:${s.id}:${new Date().toISOString().slice(0, 10)}` });
    }
  });

  // Monthly keyword refresh — 1st of month 04:00 UTC
  cron.schedule('0 4 1 * *', async () => {
    const r = await query(`SELECT id, tenant_id FROM sites WHERE verified = TRUE`);
    for (const s of r.rows) {
      await enqueue(QUEUES.keywordRefresh, Jobs.KEYWORD_REFRESH,
        { siteId: s.id, tenantId: s.tenant_id },
        { idempotencyKey: `kwrefresh:${s.id}:${new Date().toISOString().slice(0, 7)}` });
    }
  });

  // Weekly GEO/AI-visibility checks — Wednesdays 05:00 UTC
  cron.schedule('0 5 * * 3', async () => {
    const r = await query(`SELECT id, tenant_id FROM sites WHERE verified = TRUE`);
    for (const s of r.rows) {
      await enqueue(QUEUES.geoCheck, Jobs.GEO_CHECK,
        { siteId: s.id, tenantId: s.tenant_id },
        { idempotencyKey: `geo:${s.id}:${isoWeek()}` });
    }
  });

  // Weekly backlink sweep — Thursdays 06:00 UTC.
  // Reconciles provider data (or ages out CSV-uploaded links) and alerts
  // on newly lost links.
  cron.schedule('0 6 * * 4', async () => {
    const r = await query(`SELECT id, tenant_id FROM sites WHERE verified = TRUE`);
    for (const s of r.rows) {
      await enqueue(QUEUES.crawl, Jobs.BACKLINK_REFRESH,
        { siteId: s.id, tenantId: s.tenant_id },
        { idempotencyKey: `blsweep:${s.id}:${isoWeek()}` });
    }
  });

  console.log('[scheduler] cron schedules registered');
}
