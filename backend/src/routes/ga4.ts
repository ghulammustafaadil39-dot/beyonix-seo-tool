import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { encrypt } from '../crypto.js';
import { query } from '../db.js';
import { ApiError } from '../errors.js';
import { authPlugin } from '../middleware/auth.js';
import { requireRoleOrScope, requireScope } from '../middleware/access.js';
import { getGoogle, isMockGoogleAllowed } from '../providers/google.js';
import {
  OAUTH_STATE_COOKIE,
  clearOAuthStateCookie,
  consumeGa4State,
  createGa4State,
  setOAuthStateCookie,
  verifyOAuthStates,
} from '../services/oauthState.js';
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

// S-04: GA4 OAuth state now lives in the shared Redis-backed oauthState
// module (was a route-local in-memory map) — same browser binding + PKCE as
// the GSC flow.

export async function registerGa4Routes(fastify: FastifyInstance) {
  await fastify.register(async (authed) => {
    await authPlugin(authed);

    // Google OAuth for GA4. The consent screen already requests
    // analytics.readonly, so this shares the stored Google refresh token.
    // C1-M-2: initiating the OAuth flow binds the site's Google integration
    // to whoever completes consent — gate it like the read endpoints
    // (owner/admin/editor sessions, ga4:read for API keys), consistent with
    // ga4/connect which already requires editor+.
    authed.get('/sites/:id/ga4/auth-url', { schema: { params: idParamSchema }, preHandler: requireRoleOrScope(['owner', 'admin', 'editor'], 'ga4:read') }, async (req, reply) => {
      const { id } = req.params as { id: string };
      await requireSite(req.tenant.tenantId, id);
      // S-04: Redis state + signed-cookie browser binding + PKCE (was a
      // route-local in-memory map).
      const { state, codeChallenge } = await createGa4State({ tenantId: req.tenant.tenantId, siteId: id });
      setOAuthStateCookie(reply, state, req);
      const google = getGoogle();
      const url = google.isMock
        ? `${config.apiUrl}/api/v1/ga4/mock-consent?state=${encodeURIComponent(state)}`
        : google.getAuthUrl(state, { codeChallenge });
      return { url };
    });

    // List GA4 properties the connected Google account can access.
    // B1-M1: GA4 traffic data is sensitive — API keys need ga4:read.
    authed.get('/sites/:id/ga4/properties', { schema: { params: idParamSchema }, preHandler: requireScope('ga4:read') }, async (req) => {
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
      // A1-H2: integration settings are a mutation — editor+ / sites:write.
      {
        schema: { params: idParamSchema, body: connectBodySchema },
        preHandler: requireRoleOrScope(['owner', 'admin', 'editor'], 'sites:write'),
      },
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
    // B1-M1: API keys need ga4:read.
    authed.get('/sites/:id/ga4/overview', { schema: { params: idParamSchema }, preHandler: requireScope('ga4:read') }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      if (!site.ga4_connected || !site.ga4_property_id || !site.gsc_refresh_token_enc) {
        throw new ApiError(400, 'GA4_NOT_CONNECTED', 'Connect Google Analytics first');
      }
      return getGoogle().ga4Overview(site.gsc_refresh_token_enc, site.ga4_property_id);
    });

    authed.post(
      '/sites/:id/ga4/disconnect',
      // A1-H2: integration settings are a mutation — editor+ / sites:write.
      {
        schema: { params: idParamSchema },
        preHandler: requireRoleOrScope(['owner', 'admin', 'editor'], 'sites:write'),
      }, async (req) => {
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
    // S-04: browser binding first (login-CSRF defense), then one-time consume.
    const cookieVal = (req as any).cookies?.[OAUTH_STATE_COOKIE] as string | undefined;
    if (!state || !verifyOAuthStates(cookieVal, state)) {
      throw new ApiError(400, 'INVALID_STATE', 'Invalid or expired OAuth state');
    }
    const s = await consumeGa4State(state);
    if (!s || !code) {
      throw new ApiError(400, 'INVALID_STATE', 'Invalid or expired OAuth state');
    }
    const { refreshToken } = await getGoogle().exchangeCode(code, s.codeVerifier);
    await query(
      'UPDATE sites SET gsc_refresh_token_enc = $1 WHERE id = $2 AND tenant_id = $3',
      [encrypt(refreshToken), s.data.siteId, s.data.tenantId],
    );
    clearOAuthStateCookie(reply);
    return reply.redirect(`${config.appUrl}/dashboard/sites/${s.data.siteId}?ga4=1`);
  });

  // Mock consent page exists ONLY when the mock provider is allowed
  // (N-A1-6: NODE_ENV=test|development without Google credentials).
  if (isMockGoogleAllowed()) {
    fastify.get('/ga4/mock-consent', { schema: mockConsentQuerySchema }, async (req, reply) => {
      const { state } = req.query as { state: string };
      return reply.redirect(`/api/v1/ga4/callback?code=mock&state=${encodeURIComponent(state)}`);
    });
  }
}
