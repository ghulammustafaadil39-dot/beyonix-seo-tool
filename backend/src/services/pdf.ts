// Shared PDF generation (F-02 audit export, F-08 white-label reports).
// Pure pdfkit (no binaries). Callers stream the returned document.
// All text is plain (no HTML injection surface); branding colors are
// validated hex before use.

import PDFDocument from 'pdfkit';

/** pdfkit document instance type (works with @types/pdfkit's export shape). */
export type PdfDoc = InstanceType<typeof PDFDocument>;

export interface PdfBranding {
  companyName?: string | null;
  primaryColor?: string | null;
  accentColor?: string | null;
}

function safeColor(raw: string | null | undefined, fallback: string): string {
  return typeof raw === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : fallback;
}

export function brandColors(branding?: PdfBranding): { primary: string; accent: string } {
  return {
    primary: safeColor(branding?.primaryColor, '#0d9488'),
    accent: safeColor(branding?.accentColor, '#0ea5e9'),
  };
}

export function createPdf(title: string, branding?: PdfBranding): PdfDoc {
  const doc = new PDFDocument({ margin: 48, size: 'A4', info: { Title: title, Author: branding?.companyName ?? 'Beyonix SEO' } });
  return doc;
}

/** First page: branded cover with title, subtitle and date. */
export function drawCover(doc: PdfDoc, opts: { title: string; subtitle: string; branding?: PdfBranding }): void {
  const { primary } = brandColors(opts.branding);
  doc.rect(0, 0, doc.page.width, 150).fill(primary);
  doc.fillColor('#ffffff').fontSize(11).text(opts.branding?.companyName ?? 'Beyonix SEO', 48, 36);
  doc.fontSize(24).text(opts.title, 48, 60, { width: doc.page.width - 96 });
  doc.fontSize(11).fillColor('#e6fffa').text(opts.subtitle, 48, 120, { width: doc.page.width - 96 });
  doc.fillColor('#111111');
  doc.moveDown(4);
}

export function drawSectionTitle(doc: PdfDoc, text: string, branding?: PdfBranding): void {
  const { primary } = brandColors(branding);
  ensureSpace(doc, 60);
  doc.fillColor(primary).fontSize(14).text(text);
  doc.fillColor('#111111').moveDown(0.5);
}

export function drawKeyValues(doc: PdfDoc, rows: Array<[string, string]>): void {
  ensureSpace(doc, rows.length * 18 + 20);
  for (const [k, v] of rows) {
    doc.fontSize(10).fillColor('#555555').text(k, { continued: true })
      .fillColor('#111111').text(`  ${v}`);
  }
  doc.moveDown(1);
}

function ensureSpace(doc: PdfDoc, needed: number): void {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) doc.addPage();
}

export interface PdfIssue {
  severity: string;
  type: string;
  url: string;
  detail: string;
  impact: number;
  status: string;
}

/** Issue list with severity color chips; handles page breaks. */
export function drawIssues(doc: PdfDoc, issues: PdfIssue[], branding?: PdfBranding): void {
  const chip: Record<string, string> = { error: '#dc2626', warning: '#d97706', info: '#2563eb' };
  for (const issue of issues) {
    ensureSpace(doc, 70);
    const y = doc.y;
    doc.rect(48, y, 6, 6).fill(chip[issue.severity] ?? '#6b7280');
    doc.fontSize(10).fillColor('#111111')
      .text(`${issue.severity.toUpperCase()} · ${issue.type} · impact ${issue.impact}`, 60, y, { width: doc.page.width - 108 });
    doc.fontSize(9).fillColor('#374151').text(issue.url, 60, doc.y, { width: doc.page.width - 108 });
    doc.fontSize(9).fillColor('#111111').text(issue.detail, 60, doc.y, { width: doc.page.width - 108 });
    doc.moveDown(0.8);
  }
}

export function drawParagraph(doc: PdfDoc, text: string): void {
  ensureSpace(doc, 40);
  doc.fontSize(10).fillColor('#111111').text(text, { width: doc.page.width - 96 });
  doc.moveDown(0.8);
}

export function drawBullets(doc: PdfDoc, items: string[]): void {
  for (const item of items) {
    ensureSpace(doc, 30);
    doc.fontSize(10).fillColor('#111111').text(`•  ${item}`, { width: doc.page.width - 96 });
  }
  doc.moveDown(0.8);
}
