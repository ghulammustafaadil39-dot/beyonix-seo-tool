/**
 * A2-H1 regression: a tenant BYOK key without an explicit tenant provider
 * must NEVER be handed to a guessed provider (fail closed).
 *
 * Old behavior: tenant OpenAI key + server gemini default →
 * new GeminiProvider(openaiKey) — the key went to Google in the query
 * string (live credential disclosure).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getLLM, getLLMForTenant } from '../../src/providers/llm.js';
import { encrypt } from '../../src/crypto.js';
import { query } from '../integration/helpers/db.js';
import { resetDb } from '../integration/helpers/db.js';

beforeEach(async () => {
  await resetDb();
});

describe('A2-H1: BYOK key never sent to a guessed provider', () => {
  it('getLLM throws when an apiKey is supplied without an explicit provider', () => {
    expect(() => getLLM(undefined, 'sk-tenant-openai-key')).toThrow(/without an explicit provider/);
  });

  it('getLLM still works with explicit override + key', () => {
    const p = getLLM('openai', 'sk-tenant-openai-key');
    expect(p.name).toBe('openai');
    expect(p.isMock).toBe(false);
  });

  it('getLLMForTenant ignores a BYOK key when llm_provider is not set (fail closed)', async () => {
    const t = await query(
      `INSERT INTO tenants (id, name, plan_id, llm_api_key_enc) VALUES (gen_random_uuid(), 'byok', 'starter', $1) RETURNING id`,
      [encrypt('sk-tenant-openai-key')],
    );
    const tenantId = t.rows[0].id as string;

    const provider = await getLLMForTenant(tenantId);
    // No server keys are configured in the test env → mock. The key point:
    // the tenant's key must NOT be handed to a real provider instance.
    expect(provider.isMock).toBe(true);

    // And with an explicit tenant provider, the BYOK key IS used with the
    // right provider (no behavior regression for the configured path).
    await query(`UPDATE tenants SET llm_provider = 'openai' WHERE id = $1`, [tenantId]);
    const p2 = await getLLMForTenant(tenantId);
    expect(p2.name).toBe('openai');
    expect(p2.isMock).toBe(false);
  });
});
