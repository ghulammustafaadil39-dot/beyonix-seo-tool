// Backend-B Wave 2 — LA relay integration tests (rebased onto main).
// 1. Soft-delete wiring (DELETE /sites/:id -> canonical retention softDeleteSite + restore).
// 2. Circuit breaker behavior (canonical Backend-A Redis-backed breaker).
// 3. recordProviderSpend (canonical Backend-A metering) writes provider_spend.
// 4. validationError sweep spot-checks (VALIDATION_ERROR code).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { query } from '../src/db.js';
import {
  CircuitBreaker, CircuitOpenError, providerCircuit,
} from '../src/services/circuitBreaker.js';
import { recordProviderSpend, getProviderSpend } from '../src/metering.js';
import { softDeleteSite, restoreSite } from '../src/services/retention.js';
import { SHELL_TENANT_TABLES } from '../src/routes/account.js';
import {
  ensureTestDb, truncateAll, createTestUser, loginAs, authHeaders,
} from './helpers.js';

describe('circuit breaker (canonical, Redis-backed)', () => {
  it('opens after the failure threshold and fails fast', async () => {
    const name = `bb-relay-cb-${Date.now()}`;
    const b = new CircuitBreaker(name, { failureThreshold: 3, resetTimeoutMs: 60_000 });
    await b.reset();
    expect(await b.getState()).toBe('closed');
    for (let i = 0; i < 3; i++) {
      await expect(b.exec(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    }
    expect(await b.getState()).toBe('open');
    let called = false;
    await expect(b.exec(async () => { called = true; return 'never'; })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
    await b.reset();
    // success resets the breaker; half-open after the reset timeout
    const b2 = new CircuitBreaker(`${name}-2`, { failureThreshold: 1, resetTimeoutMs: 1000 });
    await b2.reset();
    await expect(b2.exec(async () => { throw new Error('x'); })).rejects.toThrow();
    expect(await b2.getState()).toBe('open');
    await new Promise((r) => setTimeout(r, 1050));
    expect(await b2.getState()).toBe('half-open');
    await expect(b2.exec(async () => 'ok')).resolves.toBe('ok');
    expect(await b2.getState()).toBe('closed');
    await b2.reset();
  });
  it('providerCircuit shares state across instances (same Redis key)', async () => {
    const name = `bb-relay-pc-${Date.now()}`;
    const a = providerCircuit(name);
    // providerCircuit uses failureThreshold 5 — trip it via the named breaker directly.
    const direct = new CircuitBreaker(`provider:${name}`, { failureThreshold: 5, resetTimeoutMs: 60_000 });
    await direct.reset();
    for (let i = 0; i < 5; i++) {
      await expect(direct.exec(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    }
    await expect(a.exec(async () => 'never')).rejects.toBeInstanceOf(CircuitOpenError);
    await direct.reset();
  });
});

let app: FastifyInstance;
let token: string;
let tenantId: string;
let siteId: string;

beforeAll(async () => {
  await ensureTestDb();
  await truncateAll();
  app = await buildApp();
  const u = await createTestUser('bb-relay@example.com', { verified: true });
  tenantId = u.tenantId;
  token = await loginAs(app, 'bb-relay@example.com');
  const s = await query(
    `INSERT INTO sites (id, tenant_id, domain, verified) VALUES (gen_random_uuid(), $1, 'relaytest.com', TRUE) RETURNING id`,
    [tenantId],
  );
  siteId = s.rows[0].id as string;
}, 60000);

afterAll(async () => {
  await app.close();
});

describe('LA relay integrations', () => {
  it('soft-deletes and restores a site via routes', async () => {
    const del = await app.inject({
      method: 'DELETE', url: `/api/v1/sites/${siteId}`, headers: authHeaders(token),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().soft_deleted).toBe(true);
    const row = await query(`SELECT deleted_at FROM sites WHERE id = $1`, [siteId]);
    expect(row.rows[0].deleted_at).not.toBeNull();
    // soft-deleted site is invisible to requireSite-backed routes
    const get = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/keywords`, headers: authHeaders(token),
    });
    expect(get.statusCode).toBe(404);
    const restore = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/restore`, headers: authHeaders(token),
    });
    expect(restore.statusCode).toBe(200);
    const row2 = await query(`SELECT deleted_at FROM sites WHERE id = $1`, [siteId]);
    expect(row2.rows[0].deleted_at).toBeNull();
  });

  it('softDeleteSite is idempotent', async () => {
    expect(await softDeleteSite(tenantId, siteId, query)).toBe(true);
    expect(await softDeleteSite(tenantId, siteId, query)).toBe(false);
    expect(await restoreSite(tenantId, siteId, query)).toBe(true);
    expect(await restoreSite(tenantId, siteId, query)).toBe(false);
  });

  it('SHELL_TENANT_TABLES covers every Backend-B tenant table (migrations 020-029)', async () => {
    const bbTables = [
      'audit_pages', 'audit_diffs', 'rank_alerts', 'alert_events', 'competitors',
      'keyword_lists', 'keyword_list_members', 'keyword_gaps', 'content_versions',
      'content_profiles', 'geo_prompts', 'link_opportunities', 'tenant_branding',
      'report_schedules', 'share_tokens',
    ];
    for (const t of bbTables) expect(SHELL_TENANT_TABLES).toContain(t);
    // Guard invariant: every listed table must actually have a tenant_id
    // column, otherwise the invite-accept guard query would SQL-error.
    for (const t of SHELL_TENANT_TABLES) {
      const r = await query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'tenant_id'`,
        [t],
      );
      expect(r.rows.length, `table ${t} must have tenant_id`).toBe(1);
    }
  });

  it('records provider spend in provider_spend (canonical metering)', async () => {
    await recordProviderSpend(tenantId, 'dataforseo', 'serp', 7, 0);
    const spend = await getProviderSpend(tenantId, { provider: 'dataforseo', feature: 'serp' });
    expect(spend.units).toBe(7);
    // C5-M-3 (Wave-4 Pass#3 BE-2): unpriced units are priced from the default
    // per-feature table — recording everything at 0 made the
    // GLOBAL_PROVIDER_DAILY_CAP_CENTS circuit a dead knob. 7 serp units at
    // 0.2c/unit = 1.4c, ceiled to 2c (integer cost_cents column).
    expect(spend.costCents).toBe(2);
  });

  it('returns VALIDATION_ERROR for invalid input (sweep)', async () => {
    const bad = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/backlinks/upload`,
      headers: authHeaders(token), payload: { csv: 'not a url at all ???' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');
    const badGeo = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/geo/check`,
      headers: authHeaders(token), payload: { query: 'x', platforms: ['chatgpt'] },
    });
    expect(badGeo.json().error.code).toBe('VALIDATION_ERROR');
  });
});
