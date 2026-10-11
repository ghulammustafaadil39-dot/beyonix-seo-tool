// White-label reports (F-08): branding, HTML/PDF rendering with tenant
// logo + colors, previous-period comparison. Rendering is deterministic;
// the executive summary comes from reporter.generateReport (LLM with cost
// caps via llmMetered, template fallback).

import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';
import type { ReportData } from './reporter.js';
import {
  createPdf, drawCover, drawSectionTitle, drawKeyValues, type PdfBranding,
} from './pdf.js';

export const REPORT_SECTIONS = ['executive', 'audit', 'keywords', 'backlinks', 'geo', 'content'] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export interface TenantBranding {
  company_name: string | null;
  logo_url: string | null;
  primary_color: string | null;
  accent_color: string | null;
}

export async function getBranding(tenantId: string, q: QueryFn = defaultQuery): Promise<TenantBranding> {
  const r = await q(`SELECT company_name, logo_url, primary_color, accent_color FROM tenant_branding WHERE tenant_id = $1`, [
    tenantId,
  ]);
  return (
    r.rows[0] ?? { company_name: null, logo_url: null, primary_color: null, accent_color: null }
  ) as TenantBranding;
}

function toPdfBranding(b: TenantBranding): PdfBranding {
  return { companyName: b.company_name, primaryColor: b.primary_color, accentColor: b.accent_color };
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeColor(raw: string | null, fallback: string): string {
  return typeof raw === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : fallback;
}

export interface ReportRenderInput {
  report: { summary: string; period_start: string; period_end: string; created_at: string };
  siteDomain: string;
  highlights: ReportData;
  branding: TenantBranding;
  sections: string[];
}

/** Branded HTML report (white-label: tenant logo + colors). */
export function renderReportHtml(input: ReportRenderInput): string {
  const { report, siteDomain, highlights: d, branding, sections } = input;
  const primary = safeColor(branding.primary_color, '#0d9488');
  const has = (s: string): boolean => sections.includes(s);
  const parts: string[] = [];
  parts.push(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(siteDomain)} SEO report</title>`);
  parts.push(`<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:0 auto;padding:32px;color:#111}
header{background:${primary};color:#fff;padding:28px;border-radius:12px;margin-bottom:24px}
h2{color:${primary};border-bottom:2px solid ${primary};padding-bottom:6px}
table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #ddd;padding:8px;text-align:left;font-size:14px}
.logo{max-height:48px;margin-bottom:8px}.muted{color:#666;font-size:13px}</style></head><body>`);
  parts.push('<header>');
  if (branding.logo_url) parts.push(`<img class="logo" src="${esc(branding.logo_url)}" alt="logo">`);
  parts.push(`<h1 style="margin:0">${esc(branding.company_name ?? 'SEO Report')}</h1>`);
  parts.push(`<div>${esc(siteDomain)} &middot; ${esc(report.period_start)} to ${esc(report.period_end)}</div></header>`);
  if (has('executive')) {
    parts.push('<h2>Executive summary</h2>');
    parts.push(...esc(report.summary).split('\n').filter(Boolean).map((p) => `<p>${p}</p>`));
  }
  if (has('audit')) {
    parts.push('<h2>Site health</h2>');
    parts.push(`<table><tr><th>Metric</th><th>Value</th></tr>
<tr><td>Health score</td><td>${d.auditScore ?? 'n/a'} / 100</td></tr>
<tr><td>Open errors</td><td>${d.openIssues.error}</td></tr>
<tr><td>Open warnings</td><td>${d.openIssues.warning}</td></tr></table>`);
  }
  if (has('keywords') && d.rankMoves.length > 0) {
    parts.push('<h2>Keyword movements</h2><table><tr><th>Keyword</th><th>Before</th><th>Now</th></tr>');
    for (const m of d.rankMoves.slice(0, 30)) {
      parts.push(`<tr><td>${esc(m.keyword)}</td><td>${m.from ?? '—'}</td><td>${m.to ?? '—'}</td></tr>`);
    }
    parts.push('</table>');
  }
  if (has('backlinks')) {
    parts.push(`<h2>Backlinks</h2><p>${d.newBacklinks} new, ${d.lostBacklinks} lost this period.</p>`);
  }
  if (has('geo')) {
    parts.push(`<h2>AI visibility</h2><p>${d.geoScore}% of simulated AI answers mentioned the brand in the last 30 days.</p>`);
  }
  if (has('content')) {
    parts.push(`<h2>Content</h2><p>${d.draftsInReview} draft(s) waiting for review.</p>`);
  }
  parts.push(`<p class="muted">Generated ${esc(report.created_at)} by ${esc(branding.company_name ?? 'Beyonix SEO')}.</p>`);
  parts.push('</body></html>');
  return parts.join('\n');
}

/** Branded PDF report via the shared pdfkit helpers. */
export async function renderReportPdf(input: ReportRenderInput): Promise<Buffer> {
  const { report, siteDomain, highlights: d, branding, sections } = input;
  const pdfBrand = toPdfBranding(branding);
  const doc = createPdf(`SEO report — ${siteDomain}`, pdfBrand);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  drawCover(doc, {
    title: `SEO report — ${siteDomain}`,
    subtitle: `${report.period_start} to ${report.period_end}`,
    branding: pdfBrand,
  });
  const has = (s: string): boolean => sections.includes(s);
  if (has('executive')) {
    drawSectionTitle(doc, 'Executive summary', pdfBrand);
    doc.fontSize(10).fillColor('#111111').text(report.summary, { width: doc.page.width - 96 });
    doc.moveDown(1);
  }
  if (has('audit')) {
    drawSectionTitle(doc, 'Site health', pdfBrand);
    drawKeyValues(doc, [
      ['Health score', `${d.auditScore ?? 'n/a'} / 100`],
      ['Open errors', String(d.openIssues.error)],
      ['Open warnings', String(d.openIssues.warning)],
    ]);
  }
  if (has('keywords') && d.rankMoves.length > 0) {
    drawSectionTitle(doc, 'Keyword movements', pdfBrand);
    drawKeyValues(
      doc,
      d.rankMoves.slice(0, 30).map((m) => [m.keyword, `${m.from ?? '—'} → ${m.to ?? '—'}`]),
    );
  }
  if (has('backlinks')) {
    drawSectionTitle(doc, 'Backlinks', pdfBrand);
    drawKeyValues(doc, [['New', String(d.newBacklinks)], ['Lost', String(d.lostBacklinks)]]);
  }
  if (has('geo')) {
    drawSectionTitle(doc, 'AI visibility', pdfBrand);
    drawKeyValues(doc, [['Mention rate (simulated)', `${d.geoScore}%`]]);
  }
  if (has('content')) {
    drawSectionTitle(doc, 'Content', pdfBrand);
    drawKeyValues(doc, [['Drafts in review', String(d.draftsInReview)]]);
  }
  doc.end();
  return done;
}

export interface PeriodComparison {
  current: { id: string; period_start: string; period_end: string };
  previous: { id: string; period_start: string; period_end: string } | null;
  deltas: {
    auditScore: number | null;
    openErrors: number | null;
    keywordsImproved: number | null;
    geoScore: number | null;
  };
}

/** Previous-period comparison from stored report highlights. */
export async function compareWithPrevious(
  tenantId: string,
  reportId: string,
  q: QueryFn = defaultQuery,
): Promise<PeriodComparison | null> {
  const cur = await q(
    `SELECT id, site_id, period_start, period_end, highlights FROM reports WHERE id = $1 AND tenant_id = $2`,
    [reportId, tenantId],
  );
  if (cur.rows.length === 0) return null;
  const current = cur.rows[0] as { id: string; site_id: string; period_start: string; period_end: string; highlights: ReportData };
  const prev = await q(
    `SELECT id, period_start, period_end, highlights FROM reports
     WHERE site_id = $1 AND tenant_id = $2 AND id <> $3
     ORDER BY created_at DESC LIMIT 1`,
    [current.site_id, tenantId, reportId],
  );
  if (prev.rows.length === 0) {
    return {
      current: { id: current.id, period_start: current.period_start, period_end: current.period_end },
      previous: null,
      deltas: { auditScore: null, openErrors: null, keywordsImproved: null, geoScore: null },
    };
  }
  const p = prev.rows[0] as { id: string; period_start: string; period_end: string; highlights: ReportData };
  const c: ReportData = current.highlights;
  const improved = (m: ReportData['rankMoves']): number =>
    m.filter((x) => x.from != null && x.to != null && x.to < x.from).length;
  return {
    current: { id: current.id, period_start: current.period_start, period_end: current.period_end },
    previous: { id: p.id, period_start: p.period_start, period_end: p.period_end },
    deltas: {
      auditScore: c.auditScore != null && p.highlights.auditScore != null ? c.auditScore - p.highlights.auditScore : null,
      openErrors: p.highlights.openIssues.error - c.openIssues.error,
      keywordsImproved: improved(c.rankMoves) - improved(p.highlights.rankMoves),
      geoScore: c.geoScore - p.highlights.geoScore,
    },
  };
}
