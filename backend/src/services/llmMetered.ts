import { getLLMForTenant } from '../providers/llm.js';
import { recordUsage } from '../metering.js';
import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';

/**
 * LLM generation that always meters ai_words usage for the tenant.
 * Honors tenant-level BYOK (tenants.llm_api_key_enc) and the 'mock' override.
 */
export async function generateMetered(
  tenantId: string,
  opts: { prompt: string; maxWords?: number; temperature?: number; siteId?: string },
  q: QueryFn = defaultQuery,
): Promise<{ text: string; words: number; provider: string }> {
  const llm = await getLLMForTenant(tenantId);
  const res = await llm.generate({ prompt: opts.prompt, maxWords: opts.maxWords, temperature: opts.temperature });
  await recordUsage(tenantId, 'ai_words', res.words, opts.siteId, { provider: llm.name }, q);
  return { ...res, provider: llm.name };
}
