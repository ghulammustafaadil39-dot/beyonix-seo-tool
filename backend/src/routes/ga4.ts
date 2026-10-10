import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config, hasGoogle } from '../config.js';
import { encrypt } from '../crypto.js';
import { query } from '../db.js';
import { ApiError } from '../errors.js';
import { authPlugin } from '../middleware/auth.js';
import { getGoogle } from '../providers/google.js';
import { requireSite } from '../services/sites.js';

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const idParamSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
} as const;

const callbackQuerySchema = {
  querystring: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      state: { type: 'string' },
    },
  },
} as const;

const mockConsentQuerySchema = {
  querystring: {
    type: 'object',
    required: ['state'],
    properties: { state: { type: 'string' } },
  },
} as const;

const connectBodySchema = {
  type: 'object',
  required: ['property_id'],
  properties: { property_id: { type: 'string', minLength: 1, maxLength: 64 } },
  additionalProperties: false,
} as const;

interface Ga4State {
  tenantId: string;
  siteId: string;
  exp: number;
}

/**
 * Validates a user-supplied GA4 property id against the property list of the
 * connected Google account, so a forged id can never be stored.
 */
export function isKnownGa4Property(
  properties: Array<{ id: string }>,
  propertyId: string,
): boolean {
  return properties.some((p) => p.id === propertyId);
}

/** state -> {tenantId, siteId, exp} for the GA4 OAuth flow. */
const ga4States = new Map<string, Ga4State>();
const GA4_STATE_TTL_MS = 15 * 60 * 1000;

function sweepGa4States() {
  if (ga4States.size < 500) return;
  const now = Date.now();
  for (const [k, v] of ga4States) {
    if (v.exp < now) ga4States.delete(k);
  }
}

export async function registerGa4Routes(fastify: FastifyInstance) {
  await fastify.register(async (authed) => {
    await authPlugin(authed);

    // Google OAuth for GA4. The consent screen already requests
    // analytics.readonly, so this shares the stored Google refresh token.
    authed.get('/sites/:id/ga4/auth-url', { schema: { params: idParamSchema } }, async (req) => {
      const { id } = req.params as { id: string };
      await requireSite(req.tenant.tenantId, id);
      const state = randomBytes(16).toString('hex');
      sweepGa4States();
      ga4States.set(state, { tenantId: req.tenant.tenantId, siteId: id, exp: Date.now() + GA4_STATE_TTL_MS });
      const google = getGoogle();
      const url = google.isMock
        ? `${config.apiUrl}/api/v1/ga4/mock-consent?state=${encodeURIComponent(state)}`
        : google.getAuthUrl(state);
      return { url };
    });

    // List GA4 properties the connected Google account can access.
    authed.get('/sites/:id/ga4/properties', { schema: { params: idParamSchema } }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      if (!site.gsc_refresh_token_enc) {
        throw new ApiError(400, 'GOOGLE_NOT_CONNECTED', 'Connect your Google account first');
      }
      const properties = await getGoogle().listGa4Properties(site.gsc_refresh_token_enc);
      return { data: properties };
    });

    // Save the chosen property. The property id is validated against the
    // account's real property list so a forged id can't be stored.
    authed.post(
      '/sites/:id/ga4/connect',
      { schema: { params: idParamSchema, body: connectBodySchema } },
      async (req) => {
        const { id } = req.params as { id: string };
        const { property_id } = req.body as { property_id: string };
        const site = await requireSite(req.tenant.tenantId, id);
        if (!site.gsc_refresh_token_enc) {
          throw new ApiError(400, 'GOOGLE_NOT_CONNECTED', 'Connect your Google account first');
        }
        const properties = await getGoogle().listGa4Properties(site.gsc_refresh_token_enc);
        if (!isKnownGa4Property(properties, property_id)) {
          throw new ApiError(400, 'UNKNOWN_PROPERTY', 'That property was not found in your Google account');
        }
        await query(
          'UPDATE sites SET ga4_connected = true, ga4_property_id = $1 WHERE id = $2 AND tenant_id = $3',
          [property_id, id, req.tenant.tenantId],
        );
        return { ok: true };
      },
    );

    // Traffic overview for the last 28 days: sessions/users/pageviews,
    // top pages and top referrers.
    authed.get('/sites/:id/ga4/overview', { schema: { params: idParamSchema } }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      if (!site.ga4_connected || !site.ga4_property_id || !site.gsc_refresh_token_enc) {
        throw new ApiError(400, 'GA4_NOT_CONNECTED', 'Connect Google Analytics first');
      }
      return getGoogle().ga4Overview(site.gsc_refresh_token_enc, site.ga4_property_id);
    });

    authed.post('/sites/:id/ga4/disconnect', { schema: { params: idParamSchema } }, async (req) => {
      const { id } = req.params as { id: string };
      await requireSite(req.tenant.tenantId, id);
      await query(
        'UPDATE sites SET ga4_connected = false, ga4_property_id = NULL WHERE id = $1 AND tenant_id = $2',
        [id, req.tenant.tenantId],
      );
      return { ok: true };
    });
  });

  fastify.get('/ga4/callback', { schema: callbackQuerySchema }, async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const s = state ? ga4States.get(state) : undefined;
    if (state) ga4States.delete(state);
    if (!state || !s || s.exp < Date.now() || !code) {
      throw new ApiError(400, 'INVALID_STATE', 'Invalid or expired OAuth state');
    }
    const { refreshToken } = await getGoogle().exchangeCode(code);
    await query(
      'UPDATE sites SET gsc_refresh_token_enc = $1 WHERE id = $2 AND tenant_id = $3',
      [encrypt(refreshToken), s.siteId, s.tenantId],
    );
    return reply.redirect(`${config.appUrl}/dashboard/sites/${s.siteId}?ga4=1`);
  });

  // Mock consent page exists ONLY when Google is not configured.
  if (!hasGoogle()) {
    fastify.get('/ga4/mock-consent', { schema: mockConsentQuerySchema }, async (req, reply) => {
      const { state } = req.query as { state: string };
      return reply.redirect(`/api/v1/ga4/callback?code=mock&state=${encodeURIComponent(state)}`);
    });
  }
}
