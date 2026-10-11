import { notFound } from '../errors.js';
import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';

/** Loads a site ensuring it belongs to the tenant. Throws 404 otherwise (no leak). */
export async function requireSite(tenantId: string, siteId: string, q: QueryFn = defaultQuery) {
  // Soft-deleted sites are invisible (canonical deleted_at from migration
  // 013, Backend-A C-06). Main's requireSite did not filter this; the filter
  // is kept here so soft-delete actually hides the site from all
  // requireSite-backed routes.
  const r = await q(`SELECT * FROM sites WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [siteId, tenantId]);
  if (r.rows.length === 0) throw notFound('Site');
  return r.rows[0] as {
    id: string; tenant_id: string; domain: string; verified: boolean;
    verify_token: string | null; gsc_connected: boolean;
    gsc_refresh_token_enc: string | null; ga4_connected: boolean;
    ga4_property_id: string | null;
    created_at: string;
  };
}

export interface PublicSite {
  id: string; tenant_id: string; domain: string; verified: boolean;
  gsc_connected: boolean; ga4_connected: boolean;
  serp_location_code: number; serp_location_name: string;
  ga4_property_id: string | null;
  created_at: string;
}

/**
 * Strips secrets before a site row leaves the API. In particular the
 * encrypted GSC refresh token must NEVER be sent to the frontend.
 */
export function toPublicSite(site: Record<string, unknown>): PublicSite {
  return {
    id: site.id as string,
    tenant_id: site.tenant_id as string,
    domain: site.domain as string,
    verified: !!site.verified,
    gsc_connected: !!site.gsc_connected,
    ga4_connected: !!site.ga4_connected,
    serp_location_code: Number(site.serp_location_code ?? 2840),
    serp_location_name: (site.serp_location_name as string) ?? 'United States',
    ga4_property_id: (site.ga4_property_id as string | null) ?? null,
    created_at: site.created_at as string,
  };
}

export function siteUrl(domain: string): string {
  return `https://${domain}`;
}

/**
 * Soft-delete / restore: CANONICAL implementation is Backend-A's C-06
 * service in services/retention.ts (sites.deleted_at comes from migration
 * 013; restore enforces the 30-day window; the retention job hard-purges
 * afterwards). Backend-B's duplicate implementation + lazy-DDL column
 * ensure were removed at the Wave-2 rebase reconciliation — these
 * re-exports keep the existing import sites working.
 * NOTE the canonical argument order: (tenantId, siteId, q).
 */
export { softDeleteSite, restoreSite } from './retention.js';
