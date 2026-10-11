import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { ApiError } from '../errors.js';
import { authPlugin } from '../middleware/auth.js';
import {
  API_SCOPES,
  isApiScope,
  requireHumanSession,
  requireRole,
  requireScope,
  actorMeta,
  actorUserId,
} from '../middleware/access.js';
import { paginate, assertUuid } from '../pagination.js';
import { logActivity } from '../services/activityLog.js';

/**
 * F-13: public API keys. Only the sha256 hash is stored; the raw key
 * (`bseo_` + 32 random bytes hex) is shown ONCE at creation.
 */
const createSchema = {
  body: {
    type: 'object',
    required: ['name', 'scopes'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      scopes: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
      rateLimitPerMin: { type: 'integer', minimum: 1, maximum: 10000 },
    },
    additionalProperties: false,
  },
} as const;

export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `bseo_${crypto.randomBytes(32).toString('hex')}`;
  return {
    raw,
    hash: crypto.createHash('sha256').update(raw).digest('hex'),
    prefix: raw.slice(0, 12),
  };
}

export async function registerApiKeyRoutes(fastify: FastifyInstance) {
  await fastify.register(async (authed) => {
    await authPlugin(authed);
    const t = (req: any) => req.tenant.tenantId as string;

    authed.get('/apikeys/scopes', async () => ({ scopes: API_SCOPES }));

    authed.get('/apikeys', { preHandler: [requireHumanSession, requireRole('owner', 'admin')] }, async (req) => { // D1-L-11: key metadata enumeration is owner/admin only
      const { page, limit, offset } = paginate(req);
      const [rows, count] = await Promise.all([
        query(
          `SELECT id, name, key_prefix, scopes, rate_limit_per_min, last_used_at, revoked_at, created_at
           FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
          [t(req), limit, offset],
        ),
        query(`SELECT COUNT(*)::int c FROM api_keys WHERE tenant_id = $1`, [t(req)]),
      ]);
      return { data: rows.rows, page, limit, total: Number(count.rows[0].c) };
    });

    authed.post(
      '/apikeys',
      {
        schema: createSchema,
        preHandler: [requireHumanSession, requireRole('owner', 'admin'), requireScope('admin')],
      },
      async (req) => {
        const { name, scopes, rateLimitPerMin } = req.body as {
          name: string;
          scopes: string[];
          rateLimitPerMin?: number;
        };
        const unknown = scopes.filter((s) => !isApiScope(s));
        if (unknown.length > 0) throw new ApiError(400, 'UNKNOWN_SCOPE', `Unknown scope(s): ${unknown.join(', ')}`);
        // F-13 fix: the 'admin' scope is NEVER mintable into an API key.
        // An admin-scoped key passed every requireRole gate (including key
        // management), so a single stolen key could mint fresh keys and
        // persist forever. Keys are least-privilege, resource-scoped only.
        if (scopes.includes('admin')) {
          throw new ApiError(
            400,
            'SCOPE_NOT_ALLOWED',
            "The 'admin' scope cannot be granted to an API key; use resource scopes (e.g. 'sites:read') instead",
          );
        }
        const { raw, hash, prefix } = generateApiKey();
        const r = await query(
          `INSERT INTO api_keys (id, tenant_id, name, key_hash, key_prefix, scopes, rate_limit_per_min, created_by)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
           RETURNING id, name, key_prefix, scopes, rate_limit_per_min, created_at`,
          [t(req), name.trim(), hash, prefix, scopes, rateLimitPerMin ?? 60, actorUserId(req)],
        );
        await logActivity(t(req), {
          userId: actorUserId(req),
          action: 'apikey.created',
          entityType: 'api_key',
          entityId: r.rows[0].id as string,
          meta: { name, scopes, ...actorMeta(req) },
        });
        return { ...r.rows[0], key: raw };
      },
    );

    authed.delete(
      '/apikeys/:id',
      { preHandler: [requireHumanSession, requireRole('owner', 'admin'), requireScope('admin')] },
      async (req) => {
        const id = assertUuid((req.params as any).id, 'key id');
        // Soft-revoke (keeps the audit trail; the hash can never be reused).
        const r = await query(
          `UPDATE api_keys SET revoked_at = now()
           WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
          [id, t(req)],
        );
        if ((r.rowCount ?? 0) === 0) throw new ApiError(404, 'NOT_FOUND', 'API key not found');
        await logActivity(t(req), {
          userId: actorUserId(req),
          action: 'apikey.revoked',
          entityType: 'api_key',
          entityId: id,
        });
        return { ok: true };
      },
    );
  });
}
