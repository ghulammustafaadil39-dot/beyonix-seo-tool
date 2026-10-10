import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config, hasGoogle } from '../config.js';
import { encrypt } from '../crypto.js';
import { query } from '../db.js';
import { ApiError } from '../errors.js';
import { authPlugin } from '../middleware/auth.js';
import { getGoogle } from '../providers/google.js';
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

interface GscState {
  tenantId: string;
  siteId: string;
  exp: number;
}

/** state -> {tenantId, siteId, exp} for the GSC OAuth flow. */
const gscStates = new Map<string, GscState>();
const GSC_STATE_TTL_MS = 15 * 60 * 1000;

function sweepGscStates() {
  if (gscStates.size < 500) return;
  const now = Date.now();
  for (const [k, v] of gscStates) {
    if (v.exp < now) gscStates.delete(k);
  }
}

export async function registerGscRoutes(fastify: FastifyInstance) {
  await fastify.register(async (authed) => {
    await authed.register(authPlugin);

    authed.get('/sites/:id/gsc/auth-url', { schema: { params: idParamSchema } }, async (req) => {
      const { id } = req.params as { id: string };
      await requireSite(req.tenant.tenantId, id);
      const state = randomBytes(16).toString('hex');
      sweepGscStates();
      gscStates.set(state, { tenantId: req.tenant.tenantId, siteId: id, exp: Date.now() + GSC_STATE_TTL_MS });
      return { url: getGoogle().getAuthUrl(state) };
    });

    authed.get('/sites/:id/gsc/queries', { schema: { params: idParamSchema } }, async (req) => {
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
    const s = state ? gscStates.get(state) : undefined;
    if (state) gscStates.delete(state);
    if (!state || !s || s.exp < Date.now() || !code) {
      throw new ApiError(400, 'INVALID_STATE', 'Invalid or expired OAuth state');
    }
    const { refreshToken } = await getGoogle().exchangeCode(code);
    await query(
      'UPDATE sites SET gsc_connected = true, gsc_refresh_token_enc = $1 WHERE id = $2 AND tenant_id = $3',
      [encrypt(refreshToken), s.siteId, s.tenantId],
    );
    return reply.redirect(`${config.appUrl}/dashboard/sites/${s.siteId}?gsc=1`);
  });

  // Mock consent page exists ONLY when Google is not configured.
  // In production with real Google keys, the OAuth flow goes to google.com.
  if (!hasGoogle()) {
    fastify.get('/gsc/mock-consent', { schema: mockConsentQuerySchema }, async (req, reply) => {
      const { state } = req.query as { state: string };
      return reply.redirect(`/api/v1/gsc/callback?code=mock&state=${encodeURIComponent(state)}`);
    });
  }
}
