// White-label branding lookups (F-08). Shared by audit PDF export and reports.
import { query as defaultQuery, type QueryFn } from '../db.js';
import type { PdfBranding } from './pdf.js';

/** Tenant branding for PDFs/HTML. Nulls when the tenant never set branding. */
export async function getBranding(tenantId: string, q: QueryFn = defaultQuery): Promise<PdfBranding> {
  const r = await q(
    `SELECT company_name, logo_url, primary_color, accent_color
     FROM tenant_branding WHERE tenant_id = $1`,
    [tenantId],
  );
  if (r.rows.length === 0) return {};
  const b = r.rows[0];
  return {
    companyName: b.company_name ?? null,
    primaryColor: b.primary_color ?? null,
    accentColor: b.accent_color ?? null,
  };
}
