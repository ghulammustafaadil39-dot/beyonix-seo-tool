import { getLLMForTenant } from '../providers/llm.js';
import { getUsage, withUsageReservation } from '../metering.js';
import { ApiError } from '../errors.js';
import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';

/**
 * W-03: per-tenant LLM cost cap (ai_words per billing window).
 * Effective cap = tenants.llm_cost_cap_words ?? env LLM_TENANT_DEFAULT_CAP_WORDS
 * (0/unset = no extra cap). Plan ai_words limits are enforced separately at
 * the choke points; this cap exists for the tenant to self-limit LLM spend.
 */
export async function llmCostCap(tenantId: string, q: QueryFn = defaultQuery): Promise<number | null> {
  const r = await q(`SELECT llm_cost_cap_words FROM tenants WHERE id = $1`, [tenantId]);
  const rowCap = r.rows[0]?.llm_cost_cap_words as number | null | undefined;
  if (rowCap != null && rowCap >= 0) return rowCap;
  const envCap = Number(process.env.LLM_TENANT_DEFAULT_CAP_WORDS ?? 0);
  return envCap > 0 ? envCap : null;
}

export async function assertLlmCap(tenantId: string, q: QueryFn = defaultQuery): Promise<void> {
  const cap = await llmCostCap(tenantId, q);
  if (cap === null) return;
  const used = await getUsage(tenantId, 'ai_words', q);
  if (used >= cap) {
    throw new ApiError(402, 'LLM_COST_CAP_EXCEEDED',
      `Tenant LLM word cap reached: ${used}/${cap} words used this period. Raise the cap in settings or wait for the next billing window.`,
      { used, cap, upgrade: false });
  }
}

/**
 * LLM generation that always meters ai_words usage for the tenant.
 * Honors tenant-level BYOK (tenants.llm_api_key_enc) and the 'mock' override.
 *
 * A1-M1: the spend is enforced with an atomic reservation (reserve the
 * maxWords estimate → generate → commit actual words / cancel on failure)
 * instead of the old check-then-act + recordUsage pair, so concurrent
 * generations can't collectively overspend the plan's ai_words budget.
 */
export async function generateMetered(
  tenantId: string,
  opts: { prompt: string; maxWords?: number; temperature?: number; siteId?: string },
  q: QueryFn = defaultQuery,
): Promise<{ text: string; words: number; provider: string }> {
  await assertLlmCap(tenantId, q); // W-03: cost cap enforced before generation
  return withUsageReservation(
    tenantId,
    'ai_words',
    opts.maxWords ?? 2000,
    async () => {
      const llm = await getLLMForTenant(tenantId);
      const res = await llm.generate({ prompt: opts.prompt, maxWords: opts.maxWords, temperature: opts.temperature });
      return { value: { ...res, provider: llm.name }, actualUnits: res.words };
    },
    { siteId: opts.siteId },
  );
}
