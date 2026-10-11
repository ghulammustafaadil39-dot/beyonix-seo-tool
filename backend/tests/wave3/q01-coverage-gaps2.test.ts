/**
 * Q-01(b) round 2: coverage gaps in worker processors.
 * contentProcessor / reportProcessor are the two largest uncovered service
 * files (contentJobs 6.9%, reportJobs 16.4%). Each test drives the REAL
 * processor against the test DB with the mock LLM/notify providers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildTestApp } from '../integration/helpers/app.js';
import { query, resetDb, uniqueEmail } from '../integration/helpers/db.js';
import { resetRedis } from '../integration/helpers/redis.js';
import { getSmtpCatcher } from '../integration/helpers/fakes.js';
import { contentProcessor } from '../../src/services/contentJobs.js';
import { reportProcessor } from '../../src/services/reportJobs.js';
import { recordUsage } from '../../src/metering.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); await resetRedis(); getSmtpCatcher().clear(); });

async function makeTenantWithSite(plan = 'starter') {
  const t = await query(
    `INSERT INTO tenants (id, name, plan_id, notify_email) VALUES (gen_random_uuid(), 'gap2', $1, $2) RETURNING id`,
    [plan, `gap2+${Date.now()}@beyo.test`],
  );
  const tenantId = t.rows[0].id as string;
  const s = await query(
    `INSERT INTO sites (id, tenant_id, domain, verified) VALUES (gen_random_uuid(), $1, 'example.com', TRUE) RETURNING id`,
    [tenantId],
  );
  return { tenantId, siteId: s.rows[0].id as string };
}

async function makePiece(tenantId: string, siteId: string, status = 'draft') {
  const r = await query(
    `INSERT INTO content_pieces (id, tenant_id, site_id, title, status)
     VALUES (gen_random_uuid(), $1, $2, 'How to do SEO', $3) RETURNING id`,
    [tenantId, siteId, status],
  );
  return r.rows[0].id as string;
}

describe('coverage gaps: content processor', () => {
  it('generates outline+draft, moves piece to review, notifies by email', async () => {
    const { tenantId, siteId } = await makeTenantWithSite();
    const pieceId = await makePiece(tenantId, siteId);
    const out = (await contentProcessor({ data: { pieceId, tenantId } } as any)) as any;
    expect(out.pieceId).toBe(pieceId);
    expect(out.words).toBeGreaterThan(0);
    const row = await query(`SELECT status, outline, draft, ai_words_used FROM content_pieces WHERE id = $1`, [pieceId]);
    expect(row.rows[0].status).toBe('review');
    expect(row.rows[0].outline.length).toBeGreaterThan(0);
    expect(row.rows[0].draft.length).toBeGreaterThan(0);
    expect(Number(row.rows[0].ai_words_used)).toBeGreaterThan(0);
    const mail = await getSmtpCatcher().waitForMessage(5000);
    expect(mail.subject).toContain('Content draft ready');
  });

  it('skips pieces that are no longer draft (idempotent)', async () => {
    const { tenantId, siteId } = await makeTenantWithSite();
    const pieceId = await makePiece(tenantId, siteId, 'approved');
    const out = (await contentProcessor({ data: { pieceId, tenantId } } as any)) as any;
    expect(out.skipped).toBe(true);
  });

  it('skips quietly when the ai_words budget is exhausted (cost guard)', async () => {
    const { tenantId, siteId } = await makeTenantWithSite();
    const pieceId = await makePiece(tenantId, siteId);
    await recordUsage(tenantId, 'ai_words', 4999, siteId); // starter limit 5000
    const out = (await contentProcessor({ data: { pieceId, tenantId } } as any)) as any;
    expect(out.skipped).toBe(true);
    expect(out.reason).toBe('ai_words_limit');
    const row = await query(`SELECT status FROM content_pieces WHERE id = $1`, [pieceId]);
    expect(row.rows[0].status).toBe('draft'); // stays retryable
  });

  it('throws on missing pieceId/tenantId and on unknown piece', async () => {
    await expect(contentProcessor({ data: {} } as any)).rejects.toThrow(/pieceId/);
    await expect(
      contentProcessor({ data: { pieceId: '00000000-0000-0000-0000-000000000000', tenantId: '00000000-0000-0000-0000-000000000000' } } as any),
    ).rejects.toThrow(/not found/);
  });
});

describe('coverage gaps: report processor', () => {
  it('builds the weekly report once, then reports skipped on re-run (idempotent)', async () => {
    const { tenantId, siteId } = await makeTenantWithSite();
    const first = (await reportProcessor({ data: { siteId, tenantId } } as any)) as any;
    expect(first.reportId).toBeTruthy();
    const rows = await query(`SELECT id, summary FROM reports WHERE site_id = $1`, [siteId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].summary.length).toBeGreaterThan(0);
    const second = (await reportProcessor({ data: { siteId, tenantId } } as any)) as any;
    expect(second.skipped).toBe(true);
    expect(second.reportId).toBe(first.reportId);
  });

  it('emails the report to the tenant notify address', async () => {
    const { tenantId, siteId } = await makeTenantWithSite();
    await reportProcessor({ data: { siteId, tenantId } } as any);
    const mail = await getSmtpCatcher().waitForMessage(5000);
    expect(mail.subject).toContain('Weekly SEO report');
  });
});
