import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';
import { positionVisibility } from './rankMetrics.js';

// W-04: Insights engine (rules-based v1 — COMPUTED, not AI-generated).
// Every action carries the evidence it was derived from. The forecast is a
// labeled PROJECTION (linear trend on a visibility index), never a promise
// and never presented as measured traffic.

export interface InsightAction {
  type: 'critical_audit_issue' | 'rank_drop' | 'content_gap' | 'unranked_keyword';
  priority: number; // 0..100, higher first
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  target: { kind: string; id?: string; href: string };
  source: 'computed';
}

export interface Forecast {
  kind: 'projection';
  label: string;
  method: string;
  visibilityIndexNow: number;
  visibilityIndexProjected: number;
  horizonDays: number;
  basedOnDays: number;
}

/** Pure: linear-regression slope over a daily series. */
export function linearSlope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0; let den = 0;
  for (let i = 0; i < n; i++) { num += (i - meanX) * (ys[i] - meanY); den += (i - meanX) ** 2; }
  return den === 0 ? 0 : num / den;
}

export async function getSiteInsights(tenantId: string, siteId: string, q: QueryFn = defaultQuery): Promise<{ actions: InsightAction[]; forecast: Forecast }> {
  const actions: InsightAction[] = [];

  // 1) Open critical (error) audit issues, grouped by type.
  const issues = await q(
    `SELECT type, COUNT(*)::int AS n, MAX(COALESCE(impact,0))::int AS impact, MIN(url) AS sample_url
     FROM audit_issues WHERE tenant_id = $1 AND site_id = $2 AND status = 'open' AND severity = 'error'
     GROUP BY type ORDER BY n DESC LIMIT 10`,
    [tenantId, siteId],
  );
  for (const r of issues.rows as any[]) {
    actions.push({
      type: 'critical_audit_issue',
      priority: Math.min(100, 82 + Math.min(10, r.n) + Math.min(8, Number(r.impact ?? 0) / 10)),
      title: `Fix critical audit issue: ${r.type} (${r.n} pages)`,
      detail: `${r.n} open error-severity issue(s) of type ${r.type}. Sample: ${r.sample_url}. Critical technical issues block crawling/indexing and outrank content work.`,
      evidence: { issueType: r.type, count: r.n, maxImpact: r.impact, sampleUrl: r.sample_url },
      target: { kind: 'audit', href: `/dashboard/sites/${siteId}?tab=audit` },
      source: 'computed',
    });
  }

  // 2) Rank drops: latest vs previous check per tracked keyword + diagnosis.
  const ranks = await q(
    `SELECT k.id, k.keyword, k.volume,
            (SELECT position FROM rank_checks WHERE keyword_id = k.id AND tenant_id = $2 ORDER BY checked_at DESC LIMIT 1) AS pos,
            (SELECT url FROM rank_checks WHERE keyword_id = k.id AND tenant_id = $2 ORDER BY checked_at DESC LIMIT 1) AS url,
            (SELECT position FROM rank_checks WHERE keyword_id = k.id AND tenant_id = $2 ORDER BY checked_at DESC LIMIT 1 OFFSET 1) AS prev,
            (SELECT url FROM rank_checks WHERE keyword_id = k.id AND tenant_id = $2 ORDER BY checked_at DESC LIMIT 1 OFFSET 1) AS prev_url
     FROM keywords k WHERE k.site_id = $1 AND k.tenant_id = $2 AND k.tracked = TRUE`,
    [siteId, tenantId],
  );
  const rows = ranks.rows as any[];
  const drops = rows.filter((r) => r.prev != null && (r.pos == null || r.pos - r.prev >= 5));
  const droppedPages = new Set(drops.map((r) => r.url ?? r.prev_url).filter(Boolean));
  for (const r of drops) {
    const delta = r.pos == null ? null : r.pos - r.prev;
    const correlates: string[] = [];
    if (drops.length >= 3) correlates.push(`${drops.length} tracked keywords dropped in the same check — site-wide pattern (technical regression or algorithm update are both consistent; neither is proven)`);
    if (r.url && r.prev_url && r.url !== r.prev_url) correlates.push(`ranking URL changed (${r.prev_url} -> ${r.url}) — possible canonical/redirect change`);
    if (droppedPages.size === 1 && drops.length > 1) correlates.push('all drops share one URL — page-level cause is more likely than site-wide');
    if (correlates.length === 0) correlates.push('no site-wide pattern detected in tracked data — competitor/SERP movement is possible but unverified');
    actions.push({
      type: 'rank_drop',
      priority: Math.min(98, 70 + (delta == null ? 20 : Math.min(25, delta))),
      title: `Investigate rank drop: "${r.keyword}" ${r.prev} -> ${r.pos == null ? 'not in top 100' : r.pos}`,
      detail: `Diagnosis (computed from tracked data): ${correlates.join('; ')}.`,
      evidence: { keywordId: r.id, keyword: r.keyword, from: r.prev, to: r.pos, delta, url: r.url, prevUrl: r.prev_url, correlates },
      target: { kind: 'keyword', id: r.id, href: `/dashboard/sites/${siteId}?tab=rankings` },
      source: 'computed',
    });
  }

  // 3) Content gaps: high-volume tracked keywords ranking poorly or not at all.
  // D1-L-7: volume comes from the main query above — no per-row SELECT.
  for (const r of rows) {
    if (r.pos != null && r.pos <= 20) continue;
    const volume = Number(r.volume ?? 0);
    if (volume < 500) continue;
    actions.push({
      type: r.pos == null ? 'unranked_keyword' : 'content_gap',
      priority: Math.min(75, 45 + Math.min(25, Math.floor(volume / 1000))),
      title: `Content gap: "${r.keyword}" (${volume}/mo searches, ${r.pos == null ? 'not ranking' : `position ${r.pos}`})`,
      detail: 'A tracked keyword with real search demand has no page ranking in the top 20 — create or substantially improve a dedicated page.',
      evidence: { keywordId: r.id, keyword: r.keyword, volume, position: r.pos },
      target: { kind: 'keyword', id: r.id, href: `/dashboard/sites/${siteId}?tab=content` },
      source: 'computed',
    });
  }

  actions.sort((a, b) => b.priority - a.priority);

  // 4) Forecast: visibility-index projection from rank history (28d -> +28d).
  const hist = await q(
    `SELECT checked_at::date AS d, AVG(pos) AS avg_pos FROM (
       SELECT rc.checked_at, rc.position AS pos FROM rank_checks rc
       JOIN keywords k ON k.id = rc.keyword_id
       WHERE rc.tenant_id = $1 AND k.site_id = $2 AND rc.position IS NOT NULL
         AND rc.checked_at >= now() - interval '28 days'
     ) s GROUP BY d ORDER BY d`,
    [tenantId, siteId],
  );
  const series = (hist.rows as any[]).map((r) => positionVisibility(Number(r.avg_pos)));
  const nowIndex = series.length ? series[series.length - 1] : 0;
  const slope = linearSlope(series);
  const projected = Math.max(0, Math.min(100, nowIndex + slope * 28));
  const forecast: Forecast = {
    kind: 'projection',
    label: 'Projection — linear trend on the rank-visibility index. NOT measured traffic and NOT a guarantee.',
    method: 'least-squares slope over daily average visibility (positionVisibility) for the last 28 days, extrapolated 28 days, clamped to [0,100]',
    visibilityIndexNow: Number(nowIndex.toFixed(2)),
    visibilityIndexProjected: Number(projected.toFixed(2)),
    horizonDays: 28,
    basedOnDays: series.length,
  };

  return { actions: actions.slice(0, 25), forecast };
}
