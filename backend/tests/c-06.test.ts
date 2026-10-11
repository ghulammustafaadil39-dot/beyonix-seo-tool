import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { pool, query, runMigrations } from '../src/db.js';
import { restoreSite, runRetentionCleanup, softDeleteSite } from '../src/services/retention.js';

/**
 * C-06 (data lifecycle): retention policy + cleanup jobs, EXPLAIN-verified
 * indexes on hot queries, soft-delete sites + restore window.
 *
 * Needs DATABASE_URL at a test database (bseo_test_ba).
 */
const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

async function explainUsesIndex(sql: string): Promise<{ plan: string; index: string | null }> {
  // Tables are tiny in tests so the planner would seq-scan; force the index
  // path off seqscan in a transaction to prove the index CAN serve the query.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = OFF');
    const r = await client.query(`EXPLAIN ${sql}`);
    await client.query('COMMIT');
    const plan = r.rows.map((row: any) => Object.values(row)[0]).join('\n');
    // Capture the index name from a plain index scan OR from the index
    // leg of a bitmap scan (the old bitmap alternative had no capture
    // group, so a bitmap plan silently yielded `undefined`).
    const m =
      /Index (?:Only )?Scan using (\S+)/.exec(plan) ?? /Bitmap Index Scan on (\S+)/.exec(plan);
    return { plan, index: m ? m[1] : null };
  } finally {
    client.release();
  }
}

describe.runIf(HAS_TEST_DB)('C-06 data lifecycle', () => {
  let tenantId: string;

  beforeAll(async () => {
    await runMigrations();
    const t = await query(
      `INSERT INTO tenants (id, name, plan_id) VALUES (gen_random_uuid(), 'c06', 'starter') RETURNING id`,
    );
    tenantId = t.rows[0].id as string;
  }, 60000);

  afterAll(async () => {
    await query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    await pool.end();
  });

  it('hot queries use indexes (EXPLAIN verified)', async () => {
    // Planner statistics on the shared test DB go stale across suite
    // runs (thousands of inserted-then-deleted rows leave reltuples
    // estimates behind, and the planner then picks a Bitmap Heap Scan
    // even for an empty table — a stats flake, not an index problem).
    // Refresh stats so EXPLAIN reflects the real (near-empty) tables,
    // which is the condition these indexes were verified under.
    await query(`ANALYZE sites`);
    await query(`ANALYZE usage_events`);
    await query(`ANALYZE keywords`);
    // Metering windowed sum (getUsage): (tenant_id, event_type, created_at).
    const u = await explainUsesIndex(
      `SELECT COALESCE(SUM(units),0)::int AS total FROM usage_events
       WHERE tenant_id = '${tenantId}' AND event_type = 'serp_check' AND created_at >= now() - interval '1 day'`,
    );
    expect(u.index).toBeTruthy();

    // Scheduler verified-site scan.
    const s = await explainUsesIndex(`SELECT id, tenant_id FROM sites WHERE verified = TRUE AND deleted_at IS NULL`);
    // D1-M-2: the partial unique index (sites_tenant_id_domain_active) may
    // win over sites_verified_idx — either is a valid index-backed plan.
    expect(s.index).toMatch(/sites_verified_idx|sites_tenant_id_domain_active/);

    // Keywords tracked per site (scheduler). NOTE (stats-flake fix):
    // TWO indexes lead with site_id — idx_keywords_site_group (002) and
    // keywords_site_tracked_idx (013, the C-06 deliverable) — and on a
    // near-empty table the planner's choice between them is a cost
    // tie-break, so asserting the exact winning name is a coin flip.
    // The verifiable C-06 contract is: the tracked index EXISTS, and
    // the hot query is index-served (never a seq scan).
    const k = await explainUsesIndex(
      `SELECT id FROM keywords WHERE site_id = '00000000-0000-0000-0000-000000000000' AND tracked = TRUE`,
    );
    expect(k.index).toBeTruthy();
    const idx = await query(
      `SELECT COUNT(*)::int c FROM pg_indexes WHERE tablename = 'keywords' AND indexname = 'keywords_site_tracked_idx'`,
    );
    expect(idx.rows[0].c).toBe(1);
  });

  it('runRetentionCleanup deletes rows older than the policy', async () => {
    await query(
      `INSERT INTO usage_events (id, tenant_id, event_type, units, created_at)
       VALUES (gen_random_uuid(), $1, 'serp_check', 5, now() - interval '14 months')`,
      [tenantId],
    );
    await query(
      `INSERT INTO usage_events (id, tenant_id, event_type, units, created_at)
       VALUES (gen_random_uuid(), $1, 'serp_check', 5, now() - interval '2 months')`,
      [tenantId],
    );
    const results = await runRetentionCleanup();
    const ue = results.find((r) => r.entity === 'usage_events');
    expect(ue).toBeTruthy();
    expect(ue!.deleted).toBeGreaterThanOrEqual(1);
    const left = await query(
      `SELECT COUNT(*)::int c FROM usage_events WHERE tenant_id = $1 AND event_type = 'serp_check'`,
      [tenantId],
    );
    expect(Number(left.rows[0].c)).toBe(1); // the 2-month-old row survives
  });

  it('retention never deletes pending webhook deliveries with scheduled retries', async () => {
    const ep = await query(
      `INSERT INTO webhook_endpoints (id, tenant_id, url, secret_enc, events)
       VALUES (gen_random_uuid(), $1, 'https://example.com/h', 'enc', '{limit.near}') RETURNING id`,
      [tenantId],
    );
    const epId = ep.rows[0].id as string;
    // 8 months old (past the 90-day policy) but retry still scheduled.
    await query(
      `INSERT INTO webhook_deliveries (id, endpoint_id, tenant_id, event, payload, status, attempts, next_retry_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'limit.near', '{}', 'pending', 1, now() + interval '1 hour',
               now() - interval '8 months')`,
      [epId, tenantId],
    );
    // 8 months old, terminal state -> swept.
    await query(
      `INSERT INTO webhook_deliveries (id, endpoint_id, tenant_id, event, payload, status, attempts, next_retry_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'limit.near', '{}', 'failed', 5, now() - interval '8 months',
               now() - interval '8 months')`,
      [epId, tenantId],
    );
    const results = await runRetentionCleanup();
    const wd = results.find((r) => r.entity === 'webhook_deliveries');
    expect(wd!.deleted).toBe(1);
    const left = await query(`SELECT status FROM webhook_deliveries WHERE tenant_id = $1`, [tenantId]);
    expect(left.rows).toHaveLength(1);
    expect(left.rows[0].status).toBe('pending');
    await query(`DELETE FROM webhook_endpoints WHERE id = $1`, [epId]);
  });

  it('soft-delete hides the site; restore works inside the window', async () => {
    const s = await query(
      `INSERT INTO sites (id, tenant_id, domain, verified) VALUES (gen_random_uuid(), $1, $2, TRUE) RETURNING id`,
      [tenantId, `softdel-${Date.now()}.test`],
    );
    const siteId = s.rows[0].id as string;

    expect(await softDeleteSite(tenantId, siteId)).toBe(true);
    const hidden = await query(`SELECT deleted_at FROM sites WHERE id = $1`, [siteId]);
    expect(hidden.rows[0].deleted_at).not.toBeNull();

    expect(await restoreSite(tenantId, siteId)).toBe(true);
    const restored = await query(`SELECT deleted_at FROM sites WHERE id = $1`, [siteId]);
    expect(restored.rows[0].deleted_at).toBeNull();

    // Another tenant cannot soft-delete it (tenant scoping).
    expect(await softDeleteSite('00000000-0000-0000-0000-000000000000', siteId)).toBe(false);
    await query(`DELETE FROM sites WHERE id = $1`, [siteId]);
  });

  it('retention has sane defaults for every managed entity (DB or built-in fallback)', async () => {
    const { DEFAULT_RETENTION_POLICIES } = await import('../src/services/retention.js');
    for (const e of ['usage_events', 'audits', 'rank_checks', 'webhook_deliveries', 'dead_letter_jobs']) {
      expect(Object.keys(DEFAULT_RETENTION_POLICIES)).toContain(e);
    }
    // The job works even when the policies table was wiped (fallback path).
    await query(`DELETE FROM retention_policies`);
    await query(
      `INSERT INTO usage_events (id, tenant_id, event_type, units, created_at)
       VALUES (gen_random_uuid(), $1, 'serp_check', 1, now() - interval '14 months')`,
      [tenantId],
    );
    const results = await runRetentionCleanup();
    const ue = results.find((r) => r.entity === 'usage_events');
    expect(ue).toBeTruthy();
    expect(ue!.deleted).toBeGreaterThanOrEqual(1);
  });
});
