import type { FastifyInstance } from 'fastify';
import { encrypt } from '../crypto.js';
import { query } from '../db.js';
import { ApiError } from '../errors.js';
import { usageSummary } from '../metering.js';
import { authPlugin } from '../middleware/auth.js';

const SETTINGS_COLS =
  'name, plan_id, notify_email, telegram_chat_id, llm_provider, (llm_api_key_enc IS NOT NULL) AS llm_key_set';

function toSettings(row: any) {
  return {
    name: row.name,
    plan_id: row.plan_id,
    notify_email: row.notify_email,
    telegram_chat_id: row.telegram_chat_id,
    llm_provider: row.llm_provider,
    llm_key_set: Boolean(row.llm_key_set),
  };
}

const patchSettingsSchema = {
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: 200 },
      notify_email: { type: ['string', 'null'], maxLength: 320 },
      telegram_chat_id: { type: ['string', 'null'], maxLength: 100 },
      llm_provider: { type: ['string', 'null'] },
      llm_api_key: { type: 'string', maxLength: 500 },
    },
    additionalProperties: false,
  },
} as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function registerSettingsRoutes(fastify: FastifyInstance) {
  await fastify.register(async (authed) => {
    await authed.register(authPlugin);

    authed.get('/settings', async (req) => {
      const r = await query(`SELECT ${SETTINGS_COLS} FROM tenants WHERE id = $1`, [req.tenant.tenantId]);
      return toSettings(r.rows[0]);
    });

    authed.patch('/settings', { schema: patchSettingsSchema }, async (req) => {
      const body = req.body as {
        name?: string;
        notify_email?: string | null;
        telegram_chat_id?: string | null;
        llm_provider?: string | null;
        llm_api_key?: string;
      };
      if (body.llm_provider !== undefined && body.llm_provider !== null && body.llm_provider !== 'mock') {
        throw new ApiError(400, 'INVALID_LLM_PROVIDER', "llm_provider must be 'mock' or null");
      }
      if (body.notify_email !== undefined && body.notify_email !== null && !EMAIL_RE.test(body.notify_email)) {
        throw new ApiError(400, 'INVALID_EMAIL', 'Notification email address is not valid');
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (col: string, val: unknown) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };
      if (body.name !== undefined) push('name', body.name.trim());
      if (body.notify_email !== undefined) push('notify_email', body.notify_email);
      if (body.telegram_chat_id !== undefined) push('telegram_chat_id', body.telegram_chat_id);
      if (body.llm_provider !== undefined) push('llm_provider', body.llm_provider);
      if (body.llm_api_key !== undefined) push('llm_api_key_enc', encrypt(body.llm_api_key));
      if (sets.length > 0) {
        params.push(req.tenant.tenantId);
        await query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }
      const r = await query(`SELECT ${SETTINGS_COLS} FROM tenants WHERE id = $1`, [req.tenant.tenantId]);
      return toSettings(r.rows[0]);
    });

    authed.get('/usage', async (req) => {
      return { limits: await usageSummary(req.tenant.tenantId, req.tenant.plan) };
    });
  });
}
