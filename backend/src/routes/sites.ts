import { randomBytes } from 'node:crypto';
import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { ApiError, conflict, notFound } from '../errors.js';
import { authPlugin } from '../middleware/auth.js';
import { assertLimit, checkLimit } from '../metering.js';
import { requireSite, toPublicSite } from '../services/sites.js';
import {
  checkVerifyToken,
  verifySiteDomain,
} from '../services/domainVerification.js';

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const idParamSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
} as const;

const createSiteSchema = {
  body: {
    type: 'object',
    required: ['domain'],
    properties: { domain: { type: 'string', maxLength: 300 } },
    additionalProperties: false,
  },
} as const;

const patchSiteSchema = {
  params: idParamSchema,
  body: {
    type: 'object',
    properties: {
      domain: { type: 'string', maxLength: 300 },
      serp_location_code: { type: 'integer' },
    },
    additionalProperties: false,
  },
} as const;

/** Curated DataForSEO location list for the "rank tracking location" picker. */
export const SERP_LOCATIONS = [
  { code: 2840, name: 'United States' },
  { code: 2826, name: 'United Kingdom' },
  { code: 124, name: 'Canada' },
  { code: 36, name: 'Australia' },
  { code: 276, name: 'Germany' },
  { code: 250, name: 'France' },
  { code: 724, name: 'Spain' },
  { code: 528, name: 'Netherlands' },
  { code: 784, name: 'United Arab Emirates' },
  { code: 682, name: 'Saudi Arabia' },
  { code: 356, name: 'India' },
  { code: 586, name: 'Pakistan' },
  { code: 702, name: 'Singapore' },
] as const;

export function serpLocationName(code: number): string | null {
  return SERP_LOCATIONS.find((l) => l.code === code)?.name ?? null;
}

const verifySchema = {
  params: idParamSchema,
  body: {
    type: 'object',
    required: ['method'],
    properties: { method: { type: 'string', enum: ['meta', 'file', 'dns'] } },
    additionalProperties: false,
  },
} as const;

/**
 * Normalizes a user-supplied domain: lowercase, strips protocol / userinfo /
 * port / path / query / hash / trailing dot. Keeps `www.` as typed.
 * Throws ApiError(400, INVALID_DOMAIN) when the result is not a valid domain.
 */
export function normalizeDomain(input: string): string {
  if (typeof input !== 'string') throw new ApiError(400, 'INVALID_DOMAIN', 'Domain must be a string');
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z0-9+.-]+:\/\//, ''); // strip protocol (http://, https://, ...)
  const at = d.lastIndexOf('@');
  if (at !== -1) d = d.slice(at + 1); // strip userinfo
  d = d.split(/[\/?#]/, 1)[0] ?? ''; // strip path / query / hash
  d = d.replace(/:\d+$/, ''); // strip port
  d = d.replace(/\.+$/, ''); // strip trailing dot(s)
  // SSRF guard: never allow IP literals or localhost as a "site".
  if (net.isIP(d)) throw new ApiError(400, 'INVALID_DOMAIN', 'IP addresses cannot be added as sites');
  if (d === 'localhost' || d.endsWith('.localhost')) {
    throw new ApiError(400, 'INVALID_DOMAIN', 'localhost cannot be added as a site');
  }
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  const ok = d.length >= 1 && d.length <= 253 && new RegExp(`^${label}(\\.${label})+$`).test(d);
  if (!ok) throw new ApiError(400, 'INVALID_DOMAIN', `Invalid domain: ${input}`);
  return d;
}

function verifyInstructions(method: 'meta' | 'file' | 'dns', token: string, domain: string): string {
  switch (method) {
    case 'meta':
      return `Add this tag inside the <head> of your homepage: <meta name="bseo-verify" content="${token}">`;
    case 'file':
      return `Serve the exact text "${token}" (no HTML) at https://${domain}/bseo-verify.txt`;
    case 'dns':
      return `Add a DNS TXT record for ${domain} with the value: bseo-verify=${token}`;
  }
}

/** S-08: hardened checks live in services/domainVerification.ts (exact parse). */

export async function registerSitesRoutes(fastify: FastifyInstance) {
  await fastify.register(async (authed) => {
    await authPlugin(authed);

    authed.post('/sites', { schema: createSiteSchema }, async (req, reply) => {
      const { domain } = req.body as { domain: string };
      const clean = normalizeDomain(domain);
      assertLimit(await checkLimit(req.tenant.tenantId, req.tenant.plan, 'sites'));
      const r = await query(
        `INSERT INTO sites (id, tenant_id, domain)
         VALUES (gen_random_uuid(), $1, $2)
         ON CONFLICT (tenant_id, domain) DO NOTHING
         RETURNING *`,
        [req.tenant.tenantId, clean],
      );
      if (r.rowCount === 0 || r.rows.length === 0) throw conflict('SITE_EXISTS', 'This domain is already added');
      return reply.status(201).send(toPublicSite(r.rows[0]));
    });

    authed.get('/sites', async (req) => {
      const r = await query('SELECT * FROM sites WHERE tenant_id = $1 ORDER BY created_at ASC', [
        req.tenant.tenantId,
      ]);
      return { data: r.rows.map(toPublicSite) };
    });

    authed.get('/sites/:id', { schema: { params: idParamSchema } }, async (req) => {
      const { id } = req.params as { id: string };
      return toPublicSite(await requireSite(req.tenant.tenantId, id));
    });

    authed.patch('/sites/:id', { schema: patchSiteSchema }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const { domain, serp_location_code } = req.body as { domain?: string; serp_location_code?: number };

      if (serp_location_code !== undefined) {
        const locName = serpLocationName(serp_location_code);
        if (!locName) throw new ApiError(400, 'INVALID_LOCATION', 'Unknown rank-tracking location');
        await query(
          'UPDATE sites SET serp_location_code = $1, serp_location_name = $2 WHERE id = $3 AND tenant_id = $4',
          [serp_location_code, locName, id, req.tenant.tenantId],
        );
      }

      if (domain === undefined) return toPublicSite(await requireSite(req.tenant.tenantId, id));
      const clean = normalizeDomain(domain);
      if (clean === site.domain) return toPublicSite(await requireSite(req.tenant.tenantId, id));
      try {
        const r = await query('UPDATE sites SET domain = $1 WHERE id = $2 AND tenant_id = $3 RETURNING *', [
          clean,
          id,
          req.tenant.tenantId,
        ]);
        return toPublicSite(r.rows[0]);
      } catch (err: any) {
        if (err?.code === '23505') throw conflict('SITE_EXISTS', 'This domain is already added');
        throw err;
      }
    });

    authed.delete('/sites/:id', { schema: { params: idParamSchema } }, async (req) => {
      const { id } = req.params as { id: string };
      const r = await query('DELETE FROM sites WHERE id = $1 AND tenant_id = $2', [id, req.tenant.tenantId]);
      if (r.rowCount === 0) throw notFound('Site');
      return { ok: true };
    });

    authed.post('/sites/:id/verify', { schema: verifySchema }, async (req) => {
      const { id } = req.params as { id: string };
      const { method } = req.body as { method: 'meta' | 'file' | 'dns' };
      const site = await requireSite(req.tenant.tenantId, id);
      // Reuse the existing token so re-submitting re-checks instead of rotating.
      const token = site.verify_token ?? randomBytes(16).toString('hex');
      if (!site.verify_token) {
        await query('UPDATE sites SET verify_token = $1 WHERE id = $2 AND tenant_id = $3', [
          token,
          id,
          req.tenant.tenantId,
        ]);
      }
      // Attempt verification on every submit (the wizard's "Check verification"
      // button re-POSTs here). verifySiteDomain sets verified_at and maps the
      // one-domain-one-tenant conflict (23505) to 409.
      let verified = site.verified;
      if (!verified) {
        verified = await verifySiteDomain(query, id, req.tenant.tenantId, () =>
          checkVerifyToken(site.domain, token),
        );
      }
      return {
        token,
        method,
        instructions: verifyInstructions(method, token, site.domain),
        verified,
      };
    });

    authed.post('/sites/:id/verify/check', { schema: { params: idParamSchema } }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      if (site.verified) return { verified: true };
      let ok = false;
      if (site.verify_token) {
        ok = await verifySiteDomain(query, id, req.tenant.tenantId, () =>
          checkVerifyToken(site.domain, site.verify_token as string),
        );
      }
      return { verified: ok };
    });

    authed.get('/sites/:id/overview', { schema: { params: idParamSchema } }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const tid = req.tenant.tenantId;

      const auditR = await query(
        `SELECT id, score, issues_count, finished_at FROM audits
         WHERE tenant_id = $1 AND site_id = $2
         ORDER BY finished_at DESC NULLS LAST, started_at DESC NULLS LAST
         LIMIT 1`,
        [tid, id],
      );
      const countsR = await query(
        `SELECT
           (SELECT COUNT(*)::int FROM keywords WHERE tenant_id = $1 AND site_id = $2 AND tracked = TRUE) AS keywords_tracked,
           (SELECT COUNT(*)::int FROM audit_issues WHERE tenant_id = $1 AND site_id = $2 AND status = 'open') AS open_issues,
           (SELECT COUNT(*)::int FROM backlinks WHERE tenant_id = $1 AND site_id = $2 AND status = 'active') AS active_backlinks,
           (SELECT COUNT(*)::int FROM content_pieces WHERE tenant_id = $1 AND site_id = $2) AS content_pieces`,
        [tid, id],
      );
      const geoR = await query(
        `SELECT COUNT(*)::int AS total,
                COALESCE(SUM(CASE WHEN mentioned THEN 1 ELSE 0 END), 0)::int AS mentioned
         FROM geo_checks
         WHERE tenant_id = $1 AND site_id = $2 AND checked_at >= now() - interval '30 days'`,
        [tid, id],
      );
      const c = countsR.rows[0];
      const g = geoR.rows[0];
      const geoScore = g.total > 0 ? Math.round((g.mentioned / g.total) * 100) : 0;
      const latestAudit = auditR.rows[0] ?? null;
      const issuesR = latestAudit
        ? await query(
            `SELECT id, type, severity, url, detail FROM audit_issues
             WHERE tenant_id = $1 AND audit_id = $2 AND status = 'open'
             ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
             LIMIT 5`,
            [tid, latestAudit.id],
          )
        : { rows: [] };
      return {
        site: toPublicSite(site),
        latestAudit,
        counts: {
          keywordsTracked: c.keywords_tracked,
          openIssues: c.open_issues,
          activeBacklinks: c.active_backlinks,
          contentPieces: c.content_pieces,
        },
        geoScore,
        // Flat keys the dashboard reads:
        score: latestAudit?.score ?? null,
        keywords_tracked: c.keywords_tracked,
        backlinks_count: c.active_backlinks,
        content_count: c.content_pieces,
        geo_score: geoScore,
        latest_issues: issuesR.rows,
        latest: { last_audit: latestAudit },
      };
    });
  });
}
