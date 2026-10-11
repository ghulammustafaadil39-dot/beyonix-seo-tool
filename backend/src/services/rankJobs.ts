// Rank-check job processor (C-05 quality pass).
//
// - Per-keyword tracking config: device / location_code / language
//   (rank_tracking_configs; defaults: site location, desktop, en).
// - Full SERP snapshots via the shared cross-tenant cache (one provider
//   call per keyword+location+device, never per tenant; metered only on
//   miss for the tenant that caused the fetch).
// - rank_checks stores position + pixel_rank (rank_absolute) + snapshot_id
//   + device/location/language. "Not in top 100" = position NULL.
// - Position-change alerts (+/-10): persisted to rank_alerts, emitted to
//   alert_events (F-10 rules hook), and sent via the tenant's notify channels.

import type { Job } from 'bullmq';
import { query as defaultQuery } from '../db.js';
import { requireSite } from './sites.js';
import { getSerpSnapshot, type SnapshotOpts } from './serpSnapshots.js';
import { assertDataBudget } from '../metering.js';
import { getNotify } from '../providers/notify.js';
import { emitAlert } from './crawlJobs.js';
import { scanKeywordAnomaly } from './rankAnomaly.js';

export interface TrackingConfig extends SnapshotOpts {
  locationCode: number;
  device: string;
  language: string;
}

export const DEFAULT_TRACKING: TrackingConfig = { locationCode: 2840, device: 'desktop', language: 'en' };

/** Pure: merge a stored config row with defaults. */
export function resolveTrackingConfig(
  row: { device?: string | null; location_code?: number | null; language?: string | null } | null,
  siteLocationCode: number,
): TrackingConfig {
  return {
    device: row?.device || 'desktop',
    locationCode: Number.isInteger(row?.location_code) && (row?.location_code as number) > 0
      ? (row?.location_code as number)
      : siteLocationCode,
    language: row?.language || 'en',
  };
}

interface RankAlert {
  keyword: string;
  keywordId: string;
  direction: 'improved' | 'dropped';
  prev: number | null;
  position: number | null;
  delta: number;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function rankCheckProcessor(job: Job): Promise<unknown> {
  const { siteId, tenantId } = (job.data ?? {}) as { siteId: string; tenantId: string };
  const q = defaultQuery;
  const site = await requireSite(tenantId, siteId, q);
  const domain = site.domain;
  const siteLocation = Number((site as { serp_location_code?: number }).serp_location_code ?? 2840) || 2840;

  const kwRows = (
    await q(
      `SELECT k.id, k.keyword,
              c.device, c.location_code, c.language
       FROM keywords k
       LEFT JOIN rank_tracking_configs c ON c.keyword_id = k.id
       WHERE k.site_id = $1 AND k.tenant_id = $2 AND k.tracked = TRUE`,
      [siteId, tenantId],
    )
  ).rows as Array<{ id: string; keyword: string; device: string | null; location_code: number | null; language: string | null }>;
  if (kwRows.length === 0) return { checked: 0, alerts: [] };

  const checkedToday = new Set<string>(
    (
      await q(
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
  // A1-M1: this stays a check-then-act PRE-FLIGHT by design — the atomic
  // enforcement lives per-call inside getSerpSnapshot() (reserve →
  // billable call → commit). A batch reservation here would hold `dueCount`
  // units for the whole job while each call also reserves, double-holding
  // budget; and the per-call reserve is what actually serializes spend.
  const dueCount = kwRows.filter((k) => !checkedToday.has(k.id)).length;
  try {
    await assertDataBudget(tenantId, 'serp_checks', dueCount, q);
  } catch (err) {
    return { checked: 0, alerts: [], skipped: 'serp_budget_exceeded', due: dueCount };
  }

  for (const kw of kwRows) {
    if (checkedToday.has(kw.id)) continue; // idempotent: already checked today
    const cfg = resolveTrackingConfig(kw, siteLocation);
    try {
      const snap = await getSerpSnapshot(tenantId, kw.keyword, domain, cfg, q);
      const prevRow = (
        await q(
          `SELECT position FROM rank_checks
           WHERE keyword_id = $1 AND tenant_id = $2 AND checked_at < date_trunc('day', now())
           ORDER BY checked_at DESC LIMIT 1`,
          [kw.id, tenantId],
        )
      ).rows[0] as { position: number | null } | undefined;
      const prev = prevRow?.position ?? null;
      await q(
        `INSERT INTO rank_checks (id, tenant_id, keyword_id, position, url, serp_features, pixel_rank, snapshot_id, device, location_code, language)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          tenantId, kw.id, snap.position, snap.url, JSON.stringify(snap.features),
          snap.pixelRank, snap.snapshotId, cfg.device, cfg.locationCode, cfg.language,
        ],
      );
      checked++;
      // W-02: anomaly detection vs rolling history (z-score |delta|>=10 rule included);
      // anomalous moves persist rank_alerts rows with anomaly=TRUE.
      void scanKeywordAnomaly(tenantId, siteId, kw.id, q).catch((e) =>
        console.error('[rank-check] anomaly scan failed:', e.message),
      );
      // Alert on moves of >= 10 positions, including falling out of / entering the top 100.
      const delta = prev !== null && snap.position !== null ? prev - snap.position
        : prev !== null && snap.position === null ? -100
        : prev === null && snap.position !== null ? 100 : 0;
      if (delta >= 10 || delta <= -10) {
        const direction = delta > 0 ? 'improved' : 'dropped';
        alerts.push({ keyword: kw.keyword, keywordId: kw.id, direction, prev, position: snap.position, delta });
        await q(
          `INSERT INTO rank_alerts (id, tenant_id, keyword_id, site_id, direction, prev_position, position, delta)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
          [tenantId, kw.id, siteId, direction, prev, snap.position, delta],
        );
        await emitAlert(q, tenantId, 'rank.changed', {
          siteId, keywordId: kw.id, keyword: kw.keyword, domain,
          direction, prev, position: snap.position, delta,
          device: cfg.device, locationCode: cfg.locationCode,
        });
      }
    } catch (err) {
      console.error(`[rank-check] keyword "${kw.keyword}" failed:`, err);
      continue; // one keyword failing must not stop the rest
    }
  }

  if (alerts.length > 0) {
    try {
      const t = (
        await q(`SELECT notify_email, telegram_chat_id FROM tenants WHERE id = $1`, [tenantId])
      ).rows[0] as { notify_email: string | null; telegram_chat_id: string | null } | undefined;
      if (t && (t.notify_email || t.telegram_chat_id)) {
        const notify = getNotify();
        const subject = `Rank movement alerts — ${domain}`;
        const fmtPos = (p: number | null): string => (p === null ? '>100' : String(p));
        const text =
          `Rank movement alerts for ${domain}:\n` +
          alerts.map((a) => `• ${a.keyword}: ${fmtPos(a.prev)} → ${fmtPos(a.position)} (${a.direction}, ${a.delta > 0 ? '+' : ''}${a.delta})`).join('\n');
        const html =
          `<h3>Rank movement alerts — ${esc(domain)}</h3><ul>` +
          alerts.map((a) => `<li><strong>${esc(a.keyword)}</strong>: ${fmtPos(a.prev)} → ${fmtPos(a.position)} (${a.direction}, ${a.delta > 0 ? '+' : ''}${a.delta})</li>`).join('') +
          `</ul>`;
        if (t.notify_email) await notify.sendEmail(t.notify_email, subject, html);
        if (t.telegram_chat_id) await notify.sendTelegram(t.telegram_chat_id, text);
      }
    } catch (err) {
      console.error('[rank-check] alert notification failed:', err);
    }
  }

  return { checked, alerts: alerts.map(({ keywordId, ...rest }) => rest) };
}
