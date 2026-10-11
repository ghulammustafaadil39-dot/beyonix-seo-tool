import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { encrypt } from '../crypto.js';
import { query } from '../db.js';
import { ApiError } from '../errors.js';
import { authPlugin } from '../middleware/auth.js';
import { requireScope } from '../middleware/access.js';
import { getGoogle, isMockGoogleAllowed } from '../providers/google.js';
import {
  OAUTH_STATE_COOKIE,
  clearOAuthStateCookie,
  consumeGscState,
  createGscState,
  setOAuthStateCookie,
  verifyOAuthStates,
} from '../services/oauthState.js';
import { requireSite, siteUrl } from '../services/sites.js';

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

export async function registerGscRoutes(fastify: FastifyInstance) {
  await fastify.register(async (authed) => {
    await authPlugin(authed);

    authed.get('/sites/:id/gsc/auth-url', { schema: { params: idParamSchema } }, async (req, reply) => {
      const { id } = req.params as { id: string };
      await requireSite(req.tenant.tenantId, id);
      // S-04: Redis state + signed-cookie browser binding + PKCE.
      const { state, codeChallenge } = await createGscState({ tenantId: req.tenant.tenantId, siteId: id });
      setOAuthStateCookie(reply, state, req);
      return { url: getGoogle().getAuthUrl(state, { codeChallenge }) };
    });

    // B1-M1: Search Console query data is sensitive — API keys need gsc:read.
    authed.get('/sites/:id/gsc/queries', { schema: { params: idParamSchema }, preHandler: requireScope('gsc:read') }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      if (!site.gsc_connected) {
        throw new ApiError(400, 'GSC_NOT_CONNECTED', 'Connect Google Search Console first');
      }
      const rows = await getGoogle().searchQueries(site.gsc_refresh_token_enc ?? '', siteUrl(site.domain));
      return { data: rows };
    });
  });

  fastify.get('/gsc/callback', { schema: callbackQuerySchema }, async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    // S-04: browser binding first (login-CSRF defense), then one-time consume.
    const cookieVal = (req as any).cookies?.[OAUTH_STATE_COOKIE] as string | undefined;
    if (!state || !verifyOAuthStates(cookieVal, state)) {
      throw new ApiError(400, 'INVALID_STATE', 'Invalid or expired OAuth state');
    }
    const s = await consumeGscState(state);
    if (!s || !code) {
      throw new ApiError(400, 'INVALID_STATE', 'Invalid or expired OAuth state');
    }
    const { refreshToken } = await getGoogle().exchangeCode(code, s.codeVerifier);
    await query(
      'UPDATE sites SET gsc_connected = true, gsc_refresh_token_enc = $1 WHERE id = $2 AND tenant_id = $3',
      [encrypt(refreshToken), s.data.siteId, s.data.tenantId],
    );
    clearOAuthStateCookie(reply);
    return reply.redirect(`${config.appUrl}/dashboard/sites/${s.data.siteId}?gsc=1`);
  });

  // Mock consent page exists ONLY when the mock provider is allowed
  // (N-A1-6: NODE_ENV=test|development without Google credentials).
  if (isMockGoogleAllowed()) {
    fastify.get('/gsc/mock-consent', { schema: mockConsentQuerySchema }, async (req, reply) => {
      const { state } = req.query as { state: string };
      return reply.redirect(`/api/v1/gsc/callback?code=mock&state=${encodeURIComponent(state)}`);
    });
  }
}
