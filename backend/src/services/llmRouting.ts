import { config } from '../config.js';
import { renderPrompt } from './prompt.js';
import type { LLMProvider } from '../providers/types.js';

// W-03: LLM layer — model routing, versioned prompt registry, golden evals,
// per-tenant cost caps (cap enforcement lives in llmMetered.ts).

export type LlmTask = 'content_draft' | 'content_outline' | 'content_brief' | 'onpage' | 'geo_answer';
export type ModelTier = 'cheap' | 'strong';

/** Task -> tier mapping (config-driven: LLM_TASK_TIERS JSON env overrides). */
export const DEFAULT_TASK_TIERS: Record<LlmTask, ModelTier> = {
  content_draft: 'strong',
  content_outline: 'cheap',
  content_brief: 'strong',
  onpage: 'cheap',
  geo_answer: 'cheap',
};

export function taskTiers(env: NodeJS.ProcessEnv = process.env): Record<LlmTask, ModelTier> {
  const out = { ...DEFAULT_TASK_TIERS };
  if (env.LLM_TASK_TIERS) {
    try {
      const parsed = JSON.parse(env.LLM_TASK_TIERS) as Record<string, string>;
      for (const k of Object.keys(out) as LlmTask[]) {
        if (parsed[k] === 'cheap' || parsed[k] === 'strong') out[k] = parsed[k];
      }
    } catch { /* bad config falls back to defaults, never crashes routing */ }
  }
  return out;
}

const CHEAP_MODELS: Record<string, string> = { gemini: 'gemini-2.0-flash', openai: 'gpt-4o-mini', mock: 'mock' };
const STRONG_MODELS: Record<string, string> = { gemini: 'gemini-2.0-pro', openai: 'gpt-4o', mock: 'mock' };

export function routeModel(task: LlmTask, providerName: string, env: NodeJS.ProcessEnv = process.env): { task: LlmTask; tier: ModelTier; model: string } {
  const tier = taskTiers(env)[task];
  const configured = providerName === 'gemini' ? config.geminiModel : providerName === 'openai' ? config.openaiModel : 'mock';
  const model = tier === 'cheap' ? (CHEAP_MODELS[providerName] ?? configured) : (STRONG_MODELS[providerName] ?? configured);
  return { task, tier, model };
}

// ---- Prompt-template registry (versioned) ----
export interface PromptTemplate { name: string; version: string; task: LlmTask }
export const PROMPT_REGISTRY: PromptTemplate[] = [
  { name: 'content-draft', version: '1.0.0', task: 'content_draft' },
  { name: 'content-outline', version: '1.0.0', task: 'content_outline' },
  { name: 'content-brief-outline', version: '1.0.0', task: 'content_brief' },
  { name: 'onpage-suggest', version: '1.0.0', task: 'onpage' },
  { name: 'geo-answer', version: '1.0.0', task: 'geo_answer' },
];
export function promptTemplate(name: string): PromptTemplate {
  const t = PROMPT_REGISTRY.find((p) => p.name === name);
  if (!t) throw new Error(`unknown prompt template: ${name}`);
  return t;
}
export async function renderVersionedPrompt(name: string, vars: Record<string, string | number>): Promise<{ text: string; version: string; task: LlmTask }> {
  const t = promptTemplate(name);
  return { text: await renderPrompt(name, vars), version: t.version, task: t.task };
}

// ---- Golden-output eval harness ----
// Fixed prompts + STRUCTURAL assertions (headings, FAQ, word bounds). These
// are regression properties of the output contract, not quality vibes. Runs
// offline against any LLMProvider (mock in tests/CI).
export interface GoldenCase { name: string; prompt: string; maxWords: number; mustContain: string[] }
export const GOLDEN_CASES: GoldenCase[] = [
  { name: 'draft-structure', prompt: 'Write a draft about local SEO for dentists', maxWords: 300, mustContain: ['### Key points', '### FAQ'] },
  { name: 'draft-word-cap', prompt: 'Write a short draft about meta titles', maxWords: 40, mustContain: ['## Draft'] },
];
export interface EvalResult { name: string; passed: boolean; failures: string[]; words: number }
export async function runGoldenEvals(llm: LLMProvider): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const c of GOLDEN_CASES) {
    const res = await llm.generate({ prompt: c.prompt, maxWords: c.maxWords });
    const failures: string[] = [];
    for (const s of c.mustContain) if (!res.text.includes(s)) failures.push(`missing: ${s}`);
    if (res.words > c.maxWords) failures.push(`words ${res.words} > cap ${c.maxWords}`);
    if (res.words === 0) failures.push('empty output');
    results.push({ name: c.name, passed: failures.length === 0, failures, words: res.words });
  }
  return results;
}
