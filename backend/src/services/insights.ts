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

// ---------------------------------------------------------------------------
// Phase 6: Insights dashboard aggregator.
//
// Pulls from ALL product surfaces and builds a unified, beginner-friendly
// dashboard. Every metric carries a plain-language explanation — no bare
// zeros. If a surface has no data yet, the metric explains WHY (e.g. "no
// audit run yet") instead of showing a confusing 0.
// ---------------------------------------------------------------------------

export interface HealthSummary {
  score: number | null;           // 0-100 from latest audit, null if none
  grade: 'excellent' | 'good' | 'needs_work' | 'critical' | 'unknown';
  summary: string;                // plain-language, beginner-friendly
  lastAuditAt: string | null;
  openIssues: number;
  openErrors: number;
}

export interface WeekOverWeek {
  scoreChange: number | null;     // latest vs previous audit score
  issuesFixed: number;            // resolved since last audit
  newIssues: number;              // new since last audit
  summary: string;
}

export interface KeywordSummary {
  tracked: number;
  avgPosition: number | null;
  avgPositionChange: number | null; // vs previous check (negative = improved)
  topGainers: Array<{ keyword: string; from: number | null; to: number | null }>;
  topLosers: Array<{ keyword: string; from: number | null; to: number | null }>;
  summary: string;
}

export interface ContentSummary {
  publishedWeek: number;
  publishedMonth: number;
  inDraft: number;
  summary: string;
}

export interface BacklinkSummary {
  prospects: number;
  contacted: number;
  replied: number;
  won: number;
  summary: string;
}

export interface GeoSummary {
  score: number | null;
  trend: 'up' | 'down' | 'flat' | 'unknown';
  summary: string;
}

export interface CompetitorSummary {
  total: number;
  autoDiscovered: number;
  summary: string;
}

export interface InsightsDashboard {
  health: HealthSummary;
  weekOverWeek: WeekOverWeek;
  keywords: KeywordSummary;
  content: ContentSummary;
  backlinks: BacklinkSummary;
  geo: GeoSummary;
  competitors: CompetitorSummary;
  computedAt: string;
}

export interface WeeklyReportSection {
  heading: string;
  items: string[];
}

export interface WeeklyReport {
  siteId: string;
  periodStart: string;
  periodEnd: string;
  whatHappened: WeeklyReportSection;
  whatImproved: WeeklyReportSection;
  nextSteps: WeeklyReportSection;
  generatedAt: string;
}

function gradeFor(score: number | null): HealthSummary['grade'] {
  if (score == null) return 'unknown';
  if (score >= 85) return 'excellent';
  if (score >= 65) return 'good';
  if (score >= 40) return 'needs_work';
  return 'critical';
}

export async function getHealthScore(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<HealthSummary> {
  const latest = await q(
    `SELECT id, score, finished_at,
            (SELECT COUNT(*)::int FROM audit_issues WHERE audit_id = a.id AND status = 'open') AS open_issues,
            (SELECT COUNT(*)::int FROM audit_issues WHERE audit_id = a.id AND status = 'open' AND severity = 'error') AS open_errors
     FROM audits a
     WHERE tenant_id = $1 AND site_id = $2 AND status = 'done'
     ORDER BY finished_at DESC LIMIT 1`,
    [tenantId, siteId],
  );
  const row = (latest.rows as any[])[0];
  if (!row) {
    return {
      score: null,
      grade: 'unknown',
      summary: 'No audit has run yet — run your first audit to get a health score.',
      lastAuditAt: null,
      openIssues: 0,
      openErrors: 0,
    };
  }
  const score = row.score != null ? Number(row.score) : null;
  const grade = gradeFor(score);
  const errNote = row.open_errors > 0 ? ` ${row.open_errors} critical issue(s) need attention.` : '';
  return {
    score,
    grade,
    summary:
      score == null
        ? 'Latest audit finished but has no score yet.'
        : `Site health is ${score}/100 (${grade.replace('_', ' ')}).${errNote}`,
    lastAuditAt: row.finished_at,
    openIssues: Number(row.open_issues ?? 0),
    openErrors: Number(row.open_errors ?? 0),
  };
}

export async function getInsightsDashboard(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<InsightsDashboard> {
  const health = await getHealthScore(tenantId, siteId, q);

  // Week-over-week: latest two finished audits.
  const audits = await q(
    `SELECT id, score, finished_at FROM audits
     WHERE tenant_id = $1 AND site_id = $2 AND status = 'done'
     ORDER BY finished_at DESC LIMIT 2`,
    [tenantId, siteId],
  );
  const aRows = audits.rows as any[];
  let weekOverWeek: WeekOverWeek;
  if (aRows.length < 2) {
    weekOverWeek = {
      scoreChange: null,
      issuesFixed: 0,
      newIssues: 0,
      summary:
        aRows.length === 0
          ? 'Run two audits to see week-over-week progress.'
          : 'Run one more audit to compare progress over time.',
    };
  } else {
    const [latest, prev] = aRows;
    const scoreChange =
      latest.score != null && prev.score != null ? Number(latest.score) - Number(prev.score) : null;
    // Issues resolved: open in prev audit, not open in latest (by type+url).
    const fixed = await q(
      `SELECT COUNT(*)::int AS c FROM audit_issues p
       WHERE p.audit_id = $1 AND p.status = 'open'
         AND NOT EXISTS (
           SELECT 1 FROM audit_issues l
           WHERE l.audit_id = $2 AND l.status = 'open'
             AND l.type = p.type AND COALESCE(l.url,'') = COALESCE(p.url,'')
         )`,
      [prev.id, latest.id],
    );
    const added = await q(
      `SELECT COUNT(*)::int AS c FROM audit_issues l
       WHERE l.audit_id = $1 AND l.status = 'open'
         AND NOT EXISTS (
           SELECT 1 FROM audit_issues p
           WHERE p.audit_id = $2
             AND p.type = l.type AND COALESCE(p.url,'') = COALESCE(l.url,'')
         )`,
      [latest.id, prev.id],
    );
    const issuesFixed = Number((fixed.rows as any[])[0]?.c ?? 0);
    const newIssues = Number((added.rows as any[])[0]?.c ?? 0);
    const dir = scoreChange == null ? '' : scoreChange > 0 ? 'improved' : scoreChange < 0 ? 'dropped' : 'unchanged';
    weekOverWeek = {
      scoreChange,
      issuesFixed,
      newIssues,
      summary:
        scoreChange == null
          ? `Compared the last two audits: ${issuesFixed} issue(s) fixed, ${newIssues} new.`
          : `Health score ${dir} by ${Math.abs(scoreChange)} points since the previous audit. ${issuesFixed} issue(s) fixed, ${newIssues} new.`,
    };
  }

  // Keywords: tracked count, avg position, movers.
  const kw = await q(
    `SELECT k.id, k.keyword,
            (SELECT position FROM rank_checks WHERE keyword_id = k.id AND tenant_id = $2 ORDER BY checked_at DESC LIMIT 1) AS pos,
            (SELECT position FROM rank_checks WHERE keyword_id = k.id AND tenant_id = $2 ORDER BY checked_at DESC LIMIT 1 OFFSET 1) AS prev
     FROM keywords k WHERE k.site_id = $1 AND k.tenant_id = $2 AND k.tracked = TRUE`,
    [siteId, tenantId],
  );
  const kwRows = kw.rows as any[];
  const withPos = kwRows.filter((r) => r.pos != null);
  const avgPosition =
    withPos.length > 0 ? withPos.reduce((s, r) => s + Number(r.pos), 0) / withPos.length : null;
  const withPrev = kwRows.filter((r) => r.pos != null && r.prev != null);
  const avgPositionChange =
    withPrev.length > 0
      ? withPrev.reduce((s, r) => s + (Number(r.pos) - Number(r.prev)), 0) / withPrev.length
      : null;
  const movers = withPrev
    .map((r) => ({ keyword: r.keyword, from: Number(r.prev), to: Number(r.pos), delta: Number(r.pos) - Number(r.prev) }))
    .sort((a, b) => a.delta - b.delta);
  const keywords: KeywordSummary = {
    tracked: kwRows.length,
    avgPosition: avgPosition != null ? Math.round(avgPosition * 10) / 10 : null,
    avgPositionChange: avgPositionChange != null ? Math.round(avgPositionChange * 10) / 10 : null,
    topGainers: movers.filter((m) => m.delta < 0).slice(0, 3).map(({ keyword, from, to }) => ({ keyword, from, to })),
    topLosers: movers.filter((m) => m.delta > 0).slice(-3).reverse().map(({ keyword, from, to }) => ({ keyword, from, to })),
    summary:
      kwRows.length === 0
        ? 'No keywords tracked yet — approve suggestions on the Keywords tab to start tracking.'
        : withPos.length === 0
          ? `${kwRows.length} keyword(s) tracked, waiting for the first rank check.`
          : `Tracking ${kwRows.length} keyword(s), average position ${avgPosition!.toFixed(1)}.`,
  };

  // Content: published this week/month, drafts.
  const content = await q(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'published' AND updated_at >= now() - interval '7 days')::int AS w,
       COUNT(*) FILTER (WHERE status = 'published' AND updated_at >= now() - interval '30 days')::int AS m,
       COUNT(*) FILTER (WHERE status IN ('draft', 'review'))::int AS d
     FROM content_pieces WHERE tenant_id = $1 AND site_id = $2`,
    [tenantId, siteId],
  ).catch(() => ({ rows: [{ w: 0, m: 0, d: 0 }] }));
  const cRow = (content.rows as any[])[0] ?? { w: 0, m: 0, d: 0 };
  const contentSummary: ContentSummary = {
    publishedWeek: Number(cRow.w ?? 0),
    publishedMonth: Number(cRow.m ?? 0),
    inDraft: Number(cRow.d ?? 0),
    summary:
      Number(cRow.w) === 0 && Number(cRow.m) === 0 && Number(cRow.d) === 0
        ? 'No content created yet — set up a content campaign to start publishing.'
        : `${cRow.w} published this week, ${cRow.m} this month, ${cRow.d} in draft/review.`,
  };

  // Backlinks: outreach funnel (Phase 2).
  const bl = await q(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status IN ('pitched','replied','won','lost'))::int AS contacted,
            COUNT(*) FILTER (WHERE status IN ('replied','won'))::int AS replied,
            COUNT(*) FILTER (WHERE status = 'won')::int AS won
     FROM outreach_prospects WHERE tenant_id = $1 AND site_id = $2`,
    [tenantId, siteId],
  ).catch(() => ({ rows: [{ total: 0, contacted: 0, replied: 0, won: 0 }] }));
  const blRow = (bl.rows as any[])[0] ?? { total: 0, contacted: 0, replied: 0, won: 0 };
  const backlinks: BacklinkSummary = {
    prospects: Number(blRow.total ?? 0),
    contacted: Number(blRow.contacted ?? 0),
    replied: Number(blRow.replied ?? 0),
    won: Number(blRow.won ?? 0),
    summary:
      Number(blRow.total) === 0
        ? 'No outreach yet — start a backlink campaign on the Backlinks tab to find link prospects.'
        : `${blRow.total} prospects found, ${blRow.contacted} contacted, ${blRow.replied} replied, ${blRow.won} link(s) won.`,
  };

  // GEO: latest readiness score + trend.
  const geo = await q(
    `SELECT score, created_at FROM geo_readiness
     WHERE tenant_id = $1 AND site_id = $2 ORDER BY created_at DESC LIMIT 2`,
    [tenantId, siteId],
  ).catch(() => ({ rows: [] }));
  const gRows = geo.rows as any[];
  let geoSummary: GeoSummary;
  if (gRows.length === 0) {
    geoSummary = {
      score: null,
      trend: 'unknown',
      summary: 'GEO readiness not checked yet — run a GEO check to see how AI-friendly your site is.',
    };
  } else {
    const latestScore = Number(gRows[0].score);
    const trend: GeoSummary['trend'] =
      gRows.length < 2 ? 'unknown'
      : Number(gRows[0].score) > Number(gRows[1].score) ? 'up'
      : Number(gRows[0].score) < Number(gRows[1].score) ? 'down' : 'flat';
    geoSummary = {
      score: latestScore,
      trend,
      summary: `AI-readiness score is ${latestScore}/100${trend !== 'unknown' ? ` (${trend === 'up' ? 'improving' : trend === 'down' ? 'declining' : 'steady'})` : ''}.`,
    };
  }

  // Competitors.
  const comp = await q(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE discovery_source = 'auto')::int AS auto_n
     FROM competitors WHERE tenant_id = $1 AND site_id = $2`,
    [tenantId, siteId],
  ).catch(() => ({ rows: [{ total: 0, auto_n: 0 }] }));
  const compRow = (comp.rows as any[])[0] ?? { total: 0, auto_n: 0 };
  const competitors: CompetitorSummary = {
    total: Number(compRow.total ?? 0),
    autoDiscovered: Number(compRow.auto_n ?? 0),
    summary:
      Number(compRow.total) === 0
        ? 'No competitors tracked yet — the tool discovers them automatically from search results.'
        : `${compRow.total} competitor(s) tracked (${compRow.auto_n} auto-discovered).`,
  };

  return {
    health,
    weekOverWeek,
    keywords,
    content: contentSummary,
    backlinks,
    geo: geoSummary,
    competitors,
    computedAt: new Date().toISOString(),
  };
}

export async function getWeeklyReport(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<WeeklyReport> {
  const dash = await getInsightsDashboard(tenantId, siteId, q);
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400 * 1000);

  // Fixes applied via autopilot in the last 7 days.
  const fixes = await q(
    `SELECT COUNT(*)::int AS c FROM site_changes
     WHERE tenant_id = $1 AND site_id = $2 AND status = 'applied' AND applied_at >= $3`,
    [tenantId, siteId, weekAgo.toISOString()],
  ).catch(() => ({ rows: [{ c: 0 }] }));
  const fixesApplied = Number((fixes.rows as any[])[0]?.c ?? 0);

  // Audits run in the last 7 days.
  const auditsRun = await q(
    `SELECT COUNT(*)::int AS c FROM audits
     WHERE tenant_id = $1 AND site_id = $2 AND status = 'done' AND finished_at >= $3`,
    [tenantId, siteId, weekAgo.toISOString()],
  ).catch(() => ({ rows: [{ c: 0 }] }));
  const auditsDone = Number((auditsRun.rows as any[])[0]?.c ?? 0);

  const whatHappened: string[] = [];
  if (auditsDone > 0) whatHappened.push(`${auditsDone} site audit(s) completed.`);
  if (fixesApplied > 0) whatHappened.push(`${fixesApplied} SEO fix(es) applied to your site.`);
  if (dash.content.publishedWeek > 0) whatHappened.push(`${dash.content.publishedWeek} blog post(s) published.`);
  if (dash.backlinks.contacted > 0) whatHappened.push(`${dash.backlinks.contacted} backlink prospect(s) contacted.`);
  if (dash.keywords.tracked > 0) whatHappened.push(`${dash.keywords.tracked} keyword(s) under tracking.`);
  if (whatHappened.length === 0) {
    whatHappened.push('Quiet week — no audits, fixes, or content yet. Run an audit to get started.');
  }

  const whatImproved: string[] = [];
  if (dash.weekOverWeek.scoreChange != null && dash.weekOverWeek.scoreChange > 0) {
    whatImproved.push(`Health score improved by ${dash.weekOverWeek.scoreChange} points.`);
  }
  if (dash.weekOverWeek.issuesFixed > 0) {
    whatImproved.push(`${dash.weekOverWeek.issuesFixed} SEO issue(s) fixed.`);
  }
  if (dash.keywords.topGainers.length > 0) {
    const g = dash.keywords.topGainers[0];
    whatImproved.push(`"${g.keyword}" climbed from position ${g.from} to ${g.to}.`);
  }
  if (dash.geo.trend === 'up' && dash.geo.score != null) {
    whatImproved.push(`AI-readiness improved to ${dash.geo.score}/100.`);
  }
  if (dash.backlinks.won > 0) {
    whatImproved.push(`${dash.backlinks.won} new backlink(s) won.`);
  }
  if (whatImproved.length === 0) {
    whatImproved.push('No measurable improvements yet — improvements show up after fixes are applied and Google re-crawls.');
  }

  // Next steps: top 3 from open errors + pending suggestions.
  const nextSteps: string[] = [];
  if (dash.health.openErrors > 0) {
    nextSteps.push(`Fix ${dash.health.openErrors} critical audit issue(s) on the Audit tab.`);
  }
  const pendSugg = await q(
    `SELECT COUNT(*)::int AS c FROM keyword_suggestions
     WHERE tenant_id = $1 AND site_id = $2 AND status = 'pending'`,
    [tenantId, siteId],
  ).catch(() => ({ rows: [{ c: 0 }] }));
  const pendingKw = Number((pendSugg.rows as any[])[0]?.c ?? 0);
  if (pendingKw > 0) {
    nextSteps.push(`Review ${pendingKw} suggested keyword(s) on the Keywords tab.`);
  }
  if (dash.keywords.topLosers.length > 0) {
    const l = dash.keywords.topLosers[0];
    nextSteps.push(`"${l.keyword}" dropped to position ${l.to} — check the Rankings tab.`);
  }
  if (dash.content.publishedWeek === 0 && dash.content.inDraft === 0) {
    nextSteps.push('Set up a content campaign to start publishing blogs.');
  }
  if (dash.geo.score == null) {
    nextSteps.push('Run a GEO check to see how AI-friendly your site is.');
  }
  while (nextSteps.length < 3) {
    nextSteps.push('Run a fresh audit to find new opportunities.');
    if (nextSteps.length >= 3) break;
  }

  return {
    siteId,
    periodStart: weekAgo.toISOString(),
    periodEnd: now.toISOString(),
    whatHappened: { heading: 'Is hafte kya hua', items: whatHappened },
    whatImproved: { heading: 'Kya behtar hua', items: whatImproved },
    nextSteps: { heading: 'Agla kadam', items: nextSteps.slice(0, 3) },
    generatedAt: now.toISOString(),
  };
}
