import { config } from '../config.js';
import type { LLMProvider, LLMGenerateOpts, LLMResult } from './types.js';
import { decrypt } from '../crypto.js';
import { query } from '../db.js';

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function truncateWords(text: string, maxWords?: number): string {
  if (!maxWords) return text;
  const words = text.trim().split(/\s+/);
  return words.length <= maxWords ? text : words.slice(0, maxWords).join(' ');
}

// Deterministic mock: builds a structured, plausible response from the prompt.
// Used when no LLM key is configured so the whole app is testable offline.
export class MockLLMProvider implements LLMProvider {
  name = 'mock';
  isMock = true;
  async generate(opts: LLMGenerateOpts): Promise<LLMResult> {
    const topic = opts.prompt.slice(0, 120).replace(/\s+/g, ' ');
    const text = [
      `## Draft (mock-generated for: ${topic}...)`,
      ``,
      `This is a placeholder draft produced by the mock LLM provider.`,
      `Connect a real LLM key (GEMINI_API_KEY or OPENAI_API_KEY) for production-quality output.`,
      ``,
      `### Key points`,
      `- Point one about the topic, written in plain language.`,
      `- Point two with a practical next step for the reader.`,
      `- Point three answering the most common follow-up question.`,
      ``,
      `### FAQ`,
      `**What is this about?** A concise answer in forty to sixty words that could stand alone.`,
      `**Why does it matter?** Because it affects rankings, visibility, and customer trust.`,
    ].join('\n');
    const out = truncateWords(text, opts.maxWords);
    return { text: out, words: countWords(out) };
  }
}

class GeminiProvider implements LLMProvider {
  name = 'gemini';
  isMock = false;
  constructor(private apiKey: string = config.geminiApiKey) {}
  async generate(opts: LLMGenerateOpts): Promise<LLMResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // B2-M5: a stalled provider (hung TLS, black-holed host) must not hang
      // the caller until the server kills the socket — the breaker only
      // counts THROWN errors, and a hung socket throws nothing by itself.
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        contents: [{ parts: [{ text: opts.prompt }] }],
        generationConfig: { temperature: opts.temperature ?? 0.7, maxOutputTokens: 4096 },
      }),
    });
    if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
    const data: any = await res.json();
    const text: string = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? '';
    if (!text) throw new Error('Gemini returned empty response');
    const out = truncateWords(text, opts.maxWords);
    return { text: out, words: countWords(out) };
  }
}

class OpenAIProvider implements LLMProvider {
  name = 'openai';
  isMock = false;
  constructor(private apiKey: string = config.openaiApiKey) {}
  async generate(opts: LLMGenerateOpts): Promise<LLMResult> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      // B2-M5: see GeminiProvider above.
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: config.openaiModel,
        messages: [{ role: 'user', content: opts.prompt }],
        temperature: opts.temperature ?? 0.7,
        max_tokens: 4096,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
    const data: any = await res.json();
    const text: string = data?.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error('OpenAI returned empty response');
    const out = truncateWords(text, opts.maxWords);
    return { text: out, words: countWords(out) };
  }
}

let cached: LLMProvider | null = null;

/** Factory: explicit override > first available key > mock.
 * A2-H1: throws when an apiKey is supplied without an explicit provider
 * (never guess a provider for a key — credential disclosure). */
export function getLLM(override?: 'gemini' | 'openai' | 'mock', apiKey?: string): LLMProvider {
  const want = override ?? config.llmProvider;
  if (want === 'mock') return new MockLLMProvider();
  // A2-H1 (hardened per SEC-REVIEW Wave-4): NEVER guess the provider for an
  // explicitly-supplied key, regardless of server config state. A tenant's
  // key routed to the config-default provider would be a live credential
  // disclosure to the wrong third party. Fail closed instead.
  if (apiKey && !override) {
    throw new Error('getLLM: apiKey supplied without an explicit provider — refusing to guess (A2-H1 fail-closed)');
  }
  if (want === 'gemini' || (!want && (apiKey || config.geminiApiKey)))
    return new GeminiProvider(apiKey || config.geminiApiKey);
  if (want === 'openai' || (!want && (apiKey || config.openaiApiKey)))
    return new OpenAIProvider(apiKey || config.openaiApiKey);
  if (!cached) {
    console.log('[provider] using MOCK llm (no GEMINI_API_KEY/OPENAI_API_KEY configured)');
    cached = new MockLLMProvider();
  }
  return cached;
}

/**
 * Tenant-aware LLM: honors the tenant's llm_provider setting
 * (mock/gemini/openai; null = server default) and BYOK key
 * (tenants.llm_api_key_enc) when set, else falls back to the
 * account-level provider selection.
 */
export async function getLLMForTenant(tenantId: string): Promise<LLMProvider> {
  try {
    const r = await query(`SELECT llm_provider, llm_api_key_enc FROM tenants WHERE id = $1`, [tenantId]);
    const row = r.rows[0];
    if (row?.llm_provider === 'mock') return new MockLLMProvider();
    let byokKey: string | undefined;
    if (row?.llm_api_key_enc) {
      try {
        byokKey = decrypt(row.llm_api_key_enc) || undefined;
      } catch {
        /* corrupted key — fall through to account provider */
      }
    }
    if (row?.llm_provider === 'gemini' || row?.llm_provider === 'openai') {
      return getLLM(row.llm_provider, byokKey);
    }
    // A2-H1: a BYOK key with no explicit tenant provider must NEVER be
    // sent to a guessed provider. Fall through to the account-level
    // provider selection (server keys) instead of leaking the tenant key
    // to the wrong third party.
    if (byokKey) {
      console.warn(
        `[provider] tenant ${tenantId} has a BYOK key but no llm_provider set — ` +
          'ignoring the BYOK key (fail closed, A2-H1); set llm_provider to use it.',
      );
    }
  } catch {
    /* DB unavailable (unit tests) — fall through */
  }
  return getLLM();
}
