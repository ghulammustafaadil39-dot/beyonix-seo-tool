// W-03: model routing, prompt registry versioning, golden evals, per-tenant cost caps.
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { pool, query, runMigrations } from '../src/db.js';
import { signupVerified, tenantCollector, auth } from './helpers-ba.js';
import { routeModel, taskTiers, PROMPT_REGISTRY, renderVersionedPrompt, runGoldenEvals } from '../src/services/llmRouting.js';
import { MockLLMProvider } from '../src/providers/llm.js';
import { assertLlmCap, generateMetered } from '../src/services/llmMetered.js';

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

describe.runIf(HAS_TEST_DB)('W-03 LLM layer', () => {
  let app: FastifyInstance;
  const tc = tenantCollector();
  beforeAll(async () => {
    await runMigrations();
    app = await buildApp();
  }, 60000);
  afterAll(async () => {
    await app?.close();
    if (tc.ids.length) await query('DELETE FROM tenants WHERE id = ANY($1)', [tc.ids]);
    await pool.end();
  });

  it('task -> tier routing: drafts strong, bulk tasks cheap', () => {
    expect(routeModel('content_draft', 'mock').tier).toBe('strong');
    expect(routeModel('geo_answer', 'mock').tier).toBe('cheap');
    expect(routeModel('onpage', 'mock').tier).toBe('cheap');
    expect(routeModel('content_brief', 'gemini').tier).toBe('strong');
  });

  it('routing is config-driven via LLM_TASK_TIERS', () => {
    const tiers = taskTiers({ LLM_TASK_TIERS: JSON.stringify({ geo_answer: 'strong' }) } as any);
    expect(tiers.geo_answer).toBe('strong');
    const bad = taskTiers({ LLM_TASK_TIERS: 'not-json' } as any);
    expect(bad.geo_answer).toBe('cheap'); // never crashes routing
  });

  it('prompt registry: every template versioned and renderable', async () => {
    expect(PROMPT_REGISTRY.length).toBeGreaterThanOrEqual(5);
    for (const t of PROMPT_REGISTRY) {
      expect(t.version).toMatch(/^\d+\.\d+\.\d+$/);
      const rendered = await renderVersionedPrompt(t.name, { keyword: 'seo', title: 't', siteDomain: 'x.com', url: 'https://x.com', metaDescription: 'm', platform: 'AI', query: 'q', tone: 'friendly' });
      expect(rendered.text.length).toBeGreaterThan(20);
      expect(rendered.version).toBe(t.version);
    }
  });

  it('golden eval harness runs green offline (mock LLM)', async () => {
    const results = await runGoldenEvals(new MockLLMProvider());
    for (const r of results) {
      expect(r.passed).toBe(true);
      if (!r.passed) console.error(r);
    }
  });

  it('cap enforcement: generateMetered 402s when the tenant word cap is reached', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: auth(u.token), payload: { llm_cost_cap_words: 10 } });
    await assertLlmCap(u.tenantId); // under cap: no throw
    // Burn 10 words of ai_words usage, then generation must refuse.
    await query(`INSERT INTO usage_events (id,tenant_id,event_type,units) VALUES (gen_random_uuid(),$1,'ai_words',10)`, [u.tenantId]);
    await expect(generateMetered(u.tenantId, { prompt: 'hello' })).rejects.toMatchObject({ status: 402, code: 'LLM_COST_CAP_EXCEEDED' });
    // And the settings round-trip exposes the cap.
    const s = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: auth(u.token) });
    expect((s.json() as any).llm_cost_cap_words).toBe(10);
  });
});
