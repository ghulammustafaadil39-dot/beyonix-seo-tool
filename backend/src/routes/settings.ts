import type { FastifyInstance } from 'fastify';
import { encrypt } from '../crypto.js';
import { hasSmtp, hasTelegram } from '../config.js';
import { query } from '../db.js';
import { ApiError, validationError } from '../errors.js';
import { usageSummary } from '../metering.js';
import { authPlugin } from '../middleware/auth.js';
import { getPayments } from '../providers/stripe.js';
import { getGoogle } from '../providers/google.js';
import { getKeywordSerpProvider } from '../providers/dataforseo.js';
import { getLLM } from '../providers/llm.js';

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
    await authPlugin(authed);

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
      // llm_provider: the real provider identifiers the product supports,
      // plus null = "use server default". The Settings UI's legacy 'default'
      // value is normalized to null so existing clients keep working.
      if (body.llm_provider !== undefined) {
        if (body.llm_provider === 'default') body.llm_provider = null;
        else if (
          body.llm_provider !== null &&
          body.llm_provider !== 'mock' &&
          body.llm_provider !== 'gemini' &&
          body.llm_provider !== 'openai'
        ) {
          throw validationError("llm_provider must be 'mock', 'gemini', 'openai' or null");
        }
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

    // N-A2-7 / frozen contract §3.2: every provider reports mock/real mode.
    authed.get('/settings/providers', async () => {
      const payments = getPayments();
      return {
        providers: [
          { name: 'payments', impl: payments.name, mode: payments.isMock ? 'mock' : 'real' },
          { name: 'google', impl: getGoogle().name, mode: getGoogle().isMock ? 'mock' : 'real' },
          {
            name: 'keyword_serp',
            impl: getKeywordSerpProvider().name,
            mode: getKeywordSerpProvider().isMock ? 'mock' : 'real',
          },
          { name: 'llm', impl: getLLM().name, mode: getLLM().isMock ? 'mock' : 'real' },
          {
            name: 'notify_email',
            impl: hasSmtp() ? 'smtp' : 'mock-log',
            mode: hasSmtp() ? 'real' : 'mock',
          },
          {
            name: 'notify_telegram',
            impl: hasTelegram() ? 'telegram' : 'mock-log',
            mode: hasTelegram() ? 'real' : 'mock',
          },
        ],
      };
    });
  });
}
