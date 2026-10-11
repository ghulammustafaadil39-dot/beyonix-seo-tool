import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';
import { generateMetered } from './llmMetered.js';
import { geoScore } from './geoService.js';
import { REPORT_SECTIONS } from './reportBranding.js';
import { requireSite } from './sites.js';

export interface ReportData {
  auditScore: number | null;
  openIssues: { error: number; warning: number; info: number };
  rankMoves: { keyword: string; from: number | null; to: number | null }[];
  newBacklinks: number;
  lostBacklinks: number;
  geoScore: number;
  draftsInReview: number;
}

/** Gathers every signal that feeds the weekly plain-language report. */
export async function collectReportData(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<ReportData> {
  // Latest finished audit + open issue counts by severity.
  const audit = await q(
    `SELECT id, score FROM audits
     WHERE tenant_id = $1 AND site_id = $2 AND status = 'done'
     ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
    [tenantId, siteId],
  );
  const auditRow = audit.rows[0] ?? null;
  const openIssues = { error: 0, warning: 0, info: 0 };
  if (auditRow) {
    const issues = await q(
      `SELECT severity, COUNT(*)::int AS c FROM audit_issues
       WHERE tenant_id = $1 AND audit_id = $2 AND status = 'open'
       GROUP BY severity`,
      [tenantId, auditRow.id],
    );
    for (const r of issues.rows) {
      const sev = String(r.severity) as keyof typeof openIssues;
      if (sev in openIssues) openIssues[sev] = Number(r.c);
    }
  }

  // Rank moves: latest position vs position ~7 days ago (computed in JS).
  const rankMoves: ReportData['rankMoves'] = [];
  const kws = await q(
    `SELECT id, keyword FROM keywords
     WHERE tenant_id = $1 AND site_id = $2 AND tracked = TRUE`,
    [tenantId, siteId],
  );
  const weekAgo = Date.now() - 7 * 86_400_000;
  for (const kw of kws.rows) {
    const checks = await q(
      `SELECT position, checked_at FROM rank_checks
       WHERE tenant_id = $1 AND keyword_id = $2
       ORDER BY checked_at DESC LIMIT 40`,
      [tenantId, kw.id],
    );
    if (checks.rows.length === 0) continue;
    const to = checks.rows[0].position as number | null;
    let from: number | null = null;
    for (const c of checks.rows) {
      if (new Date(c.checked_at).getTime() <= weekAgo) {
        from = c.position as number | null;
        break;
      }
    }
    if (from === null) from = checks.rows[checks.rows.length - 1].position as number | null;
    rankMoves.push({ keyword: kw.keyword as string, from, to });
  }

  const newBl = await q(
    `SELECT COUNT(*)::int AS c FROM backlinks
     WHERE tenant_id = $1 AND site_id = $2
       AND first_seen >= CURRENT_DATE - interval '7 days'`,
    [tenantId, siteId],
  );
  const lostBl = await q(
    `SELECT COUNT(*)::int AS c FROM backlinks
     WHERE tenant_id = $1 AND site_id = $2 AND status = 'lost'`,
    [tenantId, siteId],
  );
  const review = await q(
    `SELECT COUNT(*)::int AS c FROM content_pieces
     WHERE tenant_id = $1 AND site_id = $2 AND status = 'review'`,
    [tenantId, siteId],
  );

  return {
    auditScore: auditRow ? (auditRow.score as number | null) : null,
    openIssues,
    rankMoves,
    newBacklinks: Number(newBl.rows[0]?.c ?? 0),
    lostBacklinks: Number(lostBl.rows[0]?.c ?? 0),
    geoScore: await geoScore(tenantId, siteId, q),
    draftsInReview: Number(review.rows[0]?.c ?? 0),
  };
}

/** Plain-language multi-line summary that always works, no LLM needed. */
export function buildTemplateSummary(d: ReportData, domain: string): string {
  const lines: string[] = [
    `Weekly SEO report for ${domain}`,
    '',
    `Site health score: ${d.auditScore ?? 'n/a'} / 100`,
    `Open issues: ${d.openIssues.error} errors, ${d.openIssues.warning} warnings, ${d.openIssues.info} info`,
  ];
  if (d.rankMoves.length > 0) {
    const improved = d.rankMoves.filter(
      (m) => m.from != null && m.to != null && m.to < m.from,
    ).length;
    const declined = d.rankMoves.filter(
      (m) => m.from != null && m.to != null && m.to > m.from,
    ).length;
    lines.push(
      `Keyword rankings: ${d.rankMoves.length} tracked — ${improved} improved, ${declined} declined vs last week`,
    );
  } else {
    lines.push('Keyword rankings: no tracked keywords yet');
  }
  lines.push(
    `Backlinks: ${d.newBacklinks} new, ${d.lostBacklinks} lost`,
    `AI visibility (GEO) score: ${d.geoScore}% of AI answers mentioned your brand in the last 30 days`,
    `Content drafts waiting for review: ${d.draftsInReview}`,
    '',
    'Next step: fix open errors first — they have the biggest impact on your health score.',
  );
  return lines.join('\n');
}

/**
 * Builds the weekly report. Prefers an LLM-written summary; falls back to
 * the deterministic template when the LLM call fails.
 */
export interface GenerateReportOpts {
  /** Subset of sections to include; defaults to all. */
  sections?: string[];
  /** Reporting window in days (default 7). */
  periodDays?: number;
}

/**
 * Builds the weekly report. Prefers an LLM-written summary; falls back to
 * the deterministic template when the LLM call fails.
 * Cost caps: generateMetered enforces the tenant's ai_words budget and
 * maxWords caps the output; sections limit what the summary covers.
 */
export async function generateReport(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
  opts: GenerateReportOpts = {},
): Promise<{ summary: string; highlights: ReportData }> {
  const data = await collectReportData(tenantId, siteId, q);
  const site = await requireSite(tenantId, siteId, q);
  const sections = opts.sections && opts.sections.length > 0 ? opts.sections : [...REPORT_SECTIONS];
  let summary: string;
  try {
    const prompt =
      `Summarize this SEO week for a non-expert business owner in plain language, 250 words. ` +
      `Cover only these sections: ${sections.join(', ')}. End with one concrete next step.\n` +
      `DATA: ${JSON.stringify(data)}`;
    const res = await generateMetered(tenantId, { prompt, maxWords: 350, siteId }, q);
    summary = res.text;
  } catch {
    summary = buildTemplateSummary(data, site.domain);
  }
  return { summary, highlights: data };
}
