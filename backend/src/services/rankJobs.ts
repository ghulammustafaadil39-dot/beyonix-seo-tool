import type { Job } from 'bullmq';
import { query as defaultQuery } from '../db.js';
import { requireSite } from './sites.js';
import { getSerp } from './keywordCache.js';
import { assertDataBudget } from '../metering.js';
import { getNotify } from '../providers/notify.js';

/**
 * Pure helper: is a rank check due for a keyword last checked at
 * `lastCheckedAt`? True when never checked, or last check was before
 * today (UTC midnight).
 */
export function needsRankCheck(lastCheckedAt: Date | null): boolean {
  if (!lastCheckedAt) return true;
  const now = new Date();
  const startOfTodayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return lastCheckedAt.getTime() < startOfTodayUtc;
}

interface RankAlert {
  keyword: string;
  direction: 'improved' | 'dropped';
  prev: number;
  position: number;
  delta: number;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * rank-check job processor. Checks each tracked keyword (skipping ones
 * already checked today), records positions, and sends movement alerts
 * (±10 positions vs. the latest pre-today check) via the tenant's
 * configured email/Telegram channel.
 */
export async function rankCheckProcessor(job: Job): Promise<unknown> {
  const { siteId, tenantId } = (job.data ?? {}) as { siteId: string; tenantId: string };
  const site = await requireSite(tenantId, siteId);
  const domain = site.domain;
  const locationCode = (site as { serp_location_code?: number }).serp_location_code ?? 2840;

  const kwRows = (
    await defaultQuery(
      `SELECT id, keyword FROM keywords WHERE site_id = $1 AND tenant_id = $2 AND tracked = TRUE`,
      [siteId, tenantId],
    )
  ).rows as Array<{ id: string; keyword: string }>;
  if (kwRows.length === 0) return { checked: 0, alerts: [] };

  const checkedToday = new Set<string>(
    (
      await defaultQuery(
        `SELECT keyword_id FROM rank_checks
         WHERE keyword_id = ANY($1) AND tenant_id = $2 AND checked_at > date_trunc('day', now())`,
        [kwRows.map((k) => k.id), tenantId],
      )
    ).rows.map((r: any) => r.keyword_id as string),
  );

  const alerts: RankAlert[] = [];
  let checked = 0;

  // Batch budget pre-check: fail fast when the monthly rank-check budget is
  // exhausted instead of 402-ing on every keyword below.
  const dueCount = kwRows.filter((k) => !checkedToday.has(k.id)).length;
  try {
    await assertDataBudget(tenantId, 'serp_checks', dueCount, defaultQuery);
  } catch (err) {
    return { checked: 0, alerts: [], skipped: 'serp_budget_exceeded', due: dueCount };
  }

  for (const kw of kwRows) {
    if (checkedToday.has(kw.id)) continue; // idempotent: already checked today
    try {
      const res = await getSerp(tenantId, kw.keyword, domain, defaultQuery, undefined, locationCode);
      const prevRow = (
        await defaultQuery(
          `SELECT position FROM rank_checks
           WHERE keyword_id = $1 AND tenant_id = $2 AND checked_at < date_trunc('day', now())
           ORDER BY checked_at DESC LIMIT 1`,
          [kw.id, tenantId],
        )
      ).rows[0] as { position: number | null } | undefined;
      const prev = prevRow?.position ?? null;
      await defaultQuery(
        `INSERT INTO rank_checks (id, tenant_id, keyword_id, position, url, serp_features)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
        [tenantId, kw.id, res.position, res.url, JSON.stringify(res.features ?? [])],
      );
      checked++;
      if (prev != null && res.position != null) {
        const delta = prev - res.position; // positive = moved up
        if (delta >= 10) {
          alerts.push({ keyword: kw.keyword, direction: 'improved', prev, position: res.position, delta });
        } else if (delta <= -10) {
          alerts.push({ keyword: kw.keyword, direction: 'dropped', prev, position: res.position, delta });
        }
      }
    } catch (err) {
      console.error(`[rank-check] keyword "${kw.keyword}" failed:`, err);
      continue; // one keyword failing must not stop the rest
    }
  }

  if (alerts.length > 0) {
    try {
      const t = (
        await defaultQuery(`SELECT notify_email, telegram_chat_id FROM tenants WHERE id = $1`, [tenantId])
      ).rows[0] as { notify_email: string | null; telegram_chat_id: string | null } | undefined;
      if (t && (t.notify_email || t.telegram_chat_id)) {
        const notify = getNotify();
        const subject = `Rank movement alerts — ${domain}`;
        const text =
          `Rank movement alerts for ${domain}:\n` +
          alerts.map((a) => `• ${a.keyword}: ${a.prev} → ${a.position} (${a.direction}, ${a.delta > 0 ? '+' : ''}${a.delta})`).join('\n');
        const html =
          `<h3>Rank movement alerts — ${esc(domain)}</h3><ul>` +
          alerts.map((a) => `<li><strong>${esc(a.keyword)}</strong>: ${a.prev} → ${a.position} (${a.direction}, ${a.delta > 0 ? '+' : ''}${a.delta})</li>`).join('') +
          `</ul>`;
        if (t.notify_email) await notify.sendEmail(t.notify_email, subject, html);
        if (t.telegram_chat_id) await notify.sendTelegram(t.telegram_chat_id, text);
      }
    } catch (err) {
      console.error('[rank-check] alert notification failed:', err);
    }
  }

  return { checked, alerts };
}
