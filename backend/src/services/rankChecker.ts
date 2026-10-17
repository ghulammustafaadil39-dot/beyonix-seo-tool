// Phase 7: Free rank tracking (DuckDuckGo HTML — no paid APIs).
//
// Flow (per site, all tracked keywords):
//   1. DuckDuckGo HTML search per keyword → ordered top-10 results.
//   2. Locate the site's own domain → position (null when not in top 10).
//   3. Persist a serp_snapshots row (free cache key namespace `ddg|...`)
//      so the visibility/competitor endpoints keep working off real data.
//   4. Insert a rank_checks row (same schema the ranks routes read).
//   5. Compare with the previous check → on drops of more than 5 positions
//      (or falling out of the top 10) persist a rank_alerts row with a
//      beginner-friendly `reason` (e.g. which competitor overtook you,
//      using the Phase 3 competitors table), emit to alert_events, and
//      include it in the notification summary.
//
// The existing rankCheckProcessor (rankJobs.ts) delegates here, so the
// daily scheduler tick and the manual refresh/check routes automatically
// use the free provider. No DataForSEO budget is touched.

import { query as defaultQuery, type QueryFn } from '../db.js';
import { requireSite } from './sites.js';
import { safeFetch } from './safeFetch.js';
import { getNotify } from '../providers/notify.js';
import { emitAlert } from './crawlJobs.js';
import { scanKeywordAnomaly } from './rankAnomaly.js';
import { resolveTrackingConfig, type TrackingConfig } from './rankJobs.js';

export interface DdgSerpItem {
  position: number;
  domain: string;
  url: string;
  title: string | null;
}

export interface RankCheckResult {
  keywordId: string;
  keyword: string;
  position: number | null;
  url: string | null;
  prevPosition: number | null;
  delta: number | null;
  direction: 'improved' | 'dropped' | 'unchanged' | null;
  reason: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function domainOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (!host || !host.includes('.')) return null;
    return host;
  } catch {
    return null;
  }
}

function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^www\./, '');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * DuckDuckGo HTML search → ordered top-10 results.
 * Free, no API key. Same approach as competitorDiscovery.ts / outreach.ts.
 */
export async function ddgSerp(keyword: string): Promise<DdgSerpItem[]> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(keyword)}`;
    const res = await safeFetch(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
      },
      12000,
      5,
      { allowedContentTypes: ['text/html'] },
    );
    if (!res.ok) return [];
    const html = await res.text();
    const out: DdgSerpItem[] = [];
    const seen = new Set<string>();
    // Result links carry class="result__a"; titles are the anchor text.
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && out.length < 10) {
      let href = m[1];
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) {
        try {
          href = decodeURIComponent(uddg[1]);
        } catch {
          continue;
        }
      }
      if (!/^https?:\/\//i.test(href)) continue;
      const d = domainOf(href);
      if (!d || seen.has(d)) continue;
      seen.add(d);
      const title = m[2].replace(/<[^>]+>/g, '').trim().slice(0, 200) || null;
      out.push({ position: out.length + 1, domain: d, url: href, title });
    }
    return out;
  } catch {
    return [];
  }
}

/** Pure: locate the tenant's domain inside DDG results. */
export function findOwnPosition(
  items: DdgSerpItem[],
  domain: string,
): { position: number | null; url: string | null } {
  const want = normalizeDomain(domain);
  for (const it of items) {
    if (normalizeDomain(it.domain) === want) return { position: it.position, url: it.url };
  }
  return { position: null, url: null };
}

function fmtPos(p: number | null): string {
  return p === null ? 'outside top 10' : `#${p}`;
}

/**
 * Beginner-friendly reason for a rank drop, using the Phase 3 competitors
 * table plus the fresh snapshot items.
 */
export function detectDropReason(args: {
  keyword: string;
  prev: number | null;
  position: number | null;
  items: DdgSerpItem[];
  competitorDomains: string[];
  siteDomain: string;
}): string {
  const { prev, position, items, competitorDomains, siteDomain } = args;
  const comps = new Set(competitorDomains.map(normalizeDomain));
  const above = items.filter(
    (it) => it.position < (position ?? 11) && comps.has(normalizeDomain(it.domain)),
  );
  if (position === null && prev !== null) {
    if (above.length > 0) {
      const names = above.slice(0, 2).map((a) => `${a.domain} (#${a.position})`).join(', ');
      return `Your page fell out of Google's top 10 for this keyword. ${names} now rank${above.length > 1 ? '' : 's'} above where you were.`;
    }
    return `Your page fell out of Google's top 10 for this keyword (was ${fmtPos(prev)}). New pages may have taken its spot — consider refreshing the content.`;
  }
  if (above.length > 0) {
    const top = above[0];
    return `${top.domain} now ranks #${top.position} for this keyword and pushed you down to ${fmtPos(position)}. Check what their page does better than yours.`;
  }
  if (prev !== null && position !== null && prev - position <= -6) {
    return `Your position slipped from ${fmtPos(prev)} to ${fmtPos(position)}. Other pages moved ahead — refreshing your content or earning new links can help win it back.`;
  }
  return `Ranking changed for this keyword.`;
}

export interface RankHistoryPoint {
  checked_at: string;
  position: number | null;
  url: string | null;
}

/** Position history for charts (oldest first). */
export async function getRankHistory(
  tenantId: string,
  keywordId: string,
  days = 90,
  q: QueryFn = defaultQuery,
): Promise<RankHistoryPoint[]> {
  const d = Math.min(365, Math.max(1, days || 90));
  const r = await q(
    `SELECT checked_at, position, url FROM rank_checks
     WHERE keyword_id = $1 AND tenant_id = $2
       AND checked_at > now() - ($3 || ' days')::interval
     ORDER BY checked_at ASC LIMIT 500`,
    [keywordId, tenantId, String(d)],
  );
  return (r.rows as Array<{ checked_at: string; position: number | null; url: string | null }>).map(
    (row) => ({ checked_at: row.checked_at, position: row.position, url: row.url }),
  );
}

interface TrackedKeyword {
  id: string;
  keyword: string;
  device: string | null;
  location_code: number | null;
  language: string | null;
}

/**
 * Check all tracked keywords for a site via free DDG SERP lookups.
 * Writes rank_checks + serp_snapshots + rank_alerts (with reasons),
 * emits alert_events, and notifies the tenant of significant moves.
 * Idempotent per day: keywords already checked today are skipped.
 */
export async function checkRanks(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<{ checked: number; alerts: RankCheckResult[] }> {
  const site = await requireSite(tenantId, siteId, q);
  const domain = site.domain as string;
  const siteLocation =
    Number((site as { serp_location_code?: number }).serp_location_code ?? 2840) || 2840;

  const kwRows = (
    await q(
      `SELECT k.id, k.keyword, c.device, c.location_code, c.language
       FROM keywords k
       LEFT JOIN rank_tracking_configs c ON c.keyword_id = k.id
       WHERE k.site_id = $1 AND k.tenant_id = $2 AND k.tracked = TRUE`,
      [siteId, tenantId],
    )
  ).rows as TrackedKeyword[];
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

  const competitorDomains = (
    await q(`SELECT domain FROM competitors WHERE site_id = $1 AND tenant_id = $2`, [siteId, tenantId])
  ).rows.map((r: any) => r.domain as string);

  const alerts: RankCheckResult[] = [];
  let checked = 0;

  for (const kw of kwRows) {
    if (checkedToday.has(kw.id)) continue; // idempotent: already checked today
    const cfg: TrackingConfig = resolveTrackingConfig(kw, siteLocation);
    try {
      const items = await ddgSerp(kw.keyword);
      // Be polite to the free endpoint.
      await sleep(1200);

      const { position, url } = findOwnPosition(items, domain);

      // Persist a free snapshot so visibility/competitor endpoints keep
      // working off real data (DDG top-10 namespace avoids cache collisions).
      const cacheKey = `ddg|${kw.keyword.trim().toLowerCase()}|${cfg.locationCode}|${cfg.device}|${cfg.language}`;
      const snapRow = (
        await q(
          `INSERT INTO serp_snapshots (id, cache_key, keyword, location_code, device, language, items, features)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, '[]'::jsonb)
           ON CONFLICT (cache_key) DO UPDATE SET
             items = EXCLUDED.items, fetched_at = now(), keyword = EXCLUDED.keyword
           RETURNING id`,
          [cacheKey, kw.keyword, cfg.locationCode, cfg.device, cfg.language, JSON.stringify(items)],
        )
      ).rows[0] as { id: string };

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
         VALUES (gen_random_uuid(), $1, $2, $3, $4, '[]'::jsonb, $3, $5, $6, $7, $8)`,
        [tenantId, kw.id, position, url, snapRow.id, cfg.device, cfg.locationCode, cfg.language],
      );
      checked++;

      // Anomaly scan vs rolling history (unchanged from rankJobs).
      void scanKeywordAnomaly(tenantId, siteId, kw.id, q).catch((e) =>
        console.error('[rank-check] anomaly scan failed:', e.message),
      );

      // Movement classification. DDG covers the top 10, so "not ranked"
      // means outside the top 10. Alert on drops of MORE than 5 positions
      // (delta <= -6), on falling out of the top 10, on gains of 6+, and
      // on entering the top 10.
      const fellOut = prev !== null && position === null;
      const entered = prev === null && position !== null;
      const delta =
        prev !== null && position !== null
          ? prev - position
          : fellOut
            ? -(prev as number) // magnitude of the fall
            : entered
              ? 100
              : 0;
      const dropped = delta <= -6 || fellOut;
      const improved = entered || delta >= 6;
      const direction: RankCheckResult['direction'] = dropped
        ? 'dropped'
        : improved
          ? 'improved'
          : prev === null && position === null
            ? null
            : 'unchanged';

      if (dropped || improved) {
        const reason = dropped
          ? detectDropReason({
              keyword: kw.keyword,
              prev,
              position,
              items,
              competitorDomains,
              siteDomain: domain,
            })
          : `Good news — your page climbed to ${fmtPos(position)} for this keyword.`;
        const result: RankCheckResult = {
          keywordId: kw.id,
          keyword: kw.keyword,
          position,
          url,
          prevPosition: prev,
          delta,
          direction: direction as 'improved' | 'dropped',
          reason,
        };
        alerts.push(result);
        await q(
          `INSERT INTO rank_alerts (id, tenant_id, keyword_id, site_id, direction, prev_position, position, delta, reason)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`,
          [tenantId, kw.id, siteId, result.direction, prev, position, delta, reason],
        );
        await emitAlert(q, tenantId, 'rank.changed', {
          siteId,
          keywordId: kw.id,
          keyword: kw.keyword,
          domain,
          direction: result.direction,
          prev,
          position,
          delta,
          reason,
          device: cfg.device,
          locationCode: cfg.locationCode,
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
        const drops = alerts.filter((a) => a.direction === 'dropped');
        const subject = `Rank alerts — ${domain} (${drops.length} dropped)`;
        const fmtPos2 = (p: number | null): string => (p === null ? 'out of top 10' : `#${p}`);
        const text =
          `Rank changes for ${domain}:\n` +
          alerts
            .map((a) => `• ${a.keyword}: ${fmtPos2(a.prevPosition)} → ${fmtPos2(a.position)} (${a.direction})\n  ${a.reason ?? ''}`)
            .join('\n');
        const html =
          `<h3>Rank alerts — ${esc(domain)}</h3><ul>` +
          alerts
            .map(
              (a) =>
                `<li><strong>${esc(a.keyword)}</strong>: ${fmtPos2(a.prevPosition)} → ${fmtPos2(a.position)} (${a.direction})<br/><span>${esc(a.reason ?? '')}</span></li>`,
            )
            .join('') +
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
