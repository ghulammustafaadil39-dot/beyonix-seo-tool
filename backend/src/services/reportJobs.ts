import type { Job } from 'bullmq';
import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';
import { requireSite } from './sites.js';
import { generateReport } from './reporter.js';
import { getNotify } from '../providers/notify.js';
import { runPluginHooks } from './plugins.js';

/** Monday of the week containing `d`, as YYYY-MM-DD (UTC). */
export function weekStart(d: Date | string = new Date()): string {
  const dt = new Date(d);
  const day = dt.getUTCDay(); // 0=Sun .. 6=Sat
  const diff = (day + 6) % 7; // days since Monday
  dt.setUTCDate(dt.getUTCDate() - diff);
  return dt.toISOString().slice(0, 10);
}

function addDaysIso(iso: string, n: number): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    };
    return map[c] ?? c;
  });
}

interface ReportJobData {
  siteId: string;
  tenantId: string;
}

/**
 * Builds and stores this week's report (idempotent per site + week),
 * then notifies the tenant by email and/or Telegram.
 */
export async function reportProcessor(job: Job): Promise<unknown> {
  const { siteId, tenantId } = job.data as ReportJobData;
  const q: QueryFn = defaultQuery;
  const site = await requireSite(tenantId, siteId, q);

  const periodStart = weekStart();
  const existing = await q(
    `SELECT id FROM reports
     WHERE site_id = $1 AND tenant_id = $2 AND period_start = $3 LIMIT 1`,
    [siteId, tenantId, periodStart],
  );
  if (existing.rows.length > 0) {
    return { skipped: true, reportId: existing.rows[0].id };
  }

  const periodEnd = addDaysIso(periodStart, 6);
  const { summary, highlights } = await generateReport(tenantId, siteId, q);
  // D1-L-8: ON CONFLICT makes concurrent jobs idempotent — the loser gets
  // the winner's row instead of a raw 23505.
  const inserted = await q(
    `INSERT INTO reports (id, tenant_id, site_id, period_start, period_end, summary, highlights)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
     ON CONFLICT (site_id, period_start) DO NOTHING
     RETURNING id`,
    [tenantId, siteId, periodStart, periodEnd, summary, JSON.stringify(highlights)],
  );
  let reportId: string;
  if ((inserted.rowCount ?? 0) === 0) {
    // I2-L-1 (pass#9): we LOST the race (concurrent scheduler tick vs
    // manual generate, or a BullMQ timeout retry) — the winner notifies.
    // Falling through would send a duplicate "Weekly SEO report"
    // email + Telegram for the same report.
    const winner = await q(
      `SELECT id FROM reports WHERE site_id = $1 AND tenant_id = $2 AND period_start = $3 LIMIT 1`,
      [siteId, tenantId, periodStart],
    );
    return { skipped: true, reportId: winner.rows[0]?.id as string };
  }
  reportId = inserted.rows[0].id as string;

  // W-06: plugin hooks around report generation (errors isolated).
  void runPluginHooks('report.ready', { tenantId, siteId, resourceId: reportId, payload: { periodStart, periodEnd } }).catch((e) =>
    console.error('[plugin] report.ready hooks failed:', e.message),
  );

  try {
    const t = await q(
      `SELECT notify_email, telegram_chat_id FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const notify = getNotify();
    const preview = `Weekly SEO report for ${site.domain}: ${summary.slice(0, 500)}`;
    const email = t.rows[0]?.notify_email as string | null;
    const chatId = t.rows[0]?.telegram_chat_id as string | null;
    if (email) {
      await notify.sendEmail(
        email,
        `Weekly SEO report for ${site.domain}`,
        `<pre>${escapeHtml(preview)}</pre>`,
      );
    }
    if (chatId) {
      await notify.sendTelegram(chatId, preview);
    }
  } catch (err) {
    console.error('[report] notify failed:', (err as Error).message);
  }

  return { reportId };
}
