// W-02: SERP/volume cache provenance + TTL + multi-provider fallback + anomaly detection.
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { pool, query, runMigrations } from '../src/db.js';
import { signupVerified, tenantCollector, auth } from './helpers-ba.js';
import { getKeywordMetrics, getSerp, METRICS_TTL_DAYS, SERP_TTL_DAYS } from '../src/services/keywordCache.js';
import { createFallbackProvider, StubSecondSerpProvider } from '../src/services/serpProviderChain.js';
import { detectRankAnomaly, scanKeywordAnomaly } from '../src/services/rankAnomaly.js';
import type { KeywordSerpProvider, KeywordMetric, SerpResult } from '../src/providers/types.js';

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

class FakePrimary implements KeywordSerpProvider {
  name = 'fake-primary'; isMock = true;
  constructor(public fail = false) {}
  async keywordMetrics(keywords: string[]): Promise<KeywordMetric[]> {
    if (this.fail) throw new Error('provider down');
    return keywords.map((k) => ({ keyword: k, volume: 500, difficulty: 20 }));
  }
  async serp(): Promise<SerpResult> {
    if (this.fail) throw new Error('provider down');
    return { position: 3, url: 'https://x.example/p', features: [] };
  }
}

describe.runIf(HAS_TEST_DB)('W-02 provider data layer', () => {
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

  it('cache TTLs are 30d metrics / 7d serp by data type', () => {
    expect(METRICS_TTL_DAYS).toBe(30);
    expect(SERP_TTL_DAYS).toBe(7);
  });

  it('cache miss then hit: provenance recorded, no double metering', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    const prov = new FakePrimary();
    const kw = `w3cache-${Date.now()}`;
    const first = await getKeywordMetrics(u.tenantId, [kw], query, prov);
    expect(first[0].volume).toBe(500);
    expect((first[0] as any).source).toBe('fake-primary');
    const row = (await query(`SELECT source_provider FROM keyword_metrics_cache WHERE keyword = $1`, [kw.toLowerCase()])).rows[0];
    expect(row.source_provider).toBe('fake-primary');
    const used1 = Number((await query(`SELECT COALESCE(SUM(units),0)::int c FROM usage_events WHERE tenant_id=$1 AND event_type='keyword_metric'`, [u.tenantId])).rows[0].c);
    await getKeywordMetrics(u.tenantId, [kw], query, prov);
    const used2 = Number((await query(`SELECT COALESCE(SUM(units),0)::int c FROM usage_events WHERE tenant_id=$1 AND event_type='keyword_metric'`, [u.tenantId])).rows[0].c);
    expect(used2).toBe(used1); // hit is not metered
  });

  it('stale cache rows refetch (TTL expiry honored)', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    const kw = `w3stale-${Date.now()}`;
    await query(`INSERT INTO keyword_metrics_cache (keyword, location_code, volume, difficulty, fetched_at, source_provider)
      VALUES ($1, 2840, 10, 5, now() - interval '31 days', 'old')`, [kw.toLowerCase()]);
    const prov = new FakePrimary();
    const res = await getKeywordMetrics(u.tenantId, [kw], query, prov);
    expect(res[0].volume).toBe(500); // refetched, not the stale 10
    expect((res[0] as any).source).toBe('fake-primary');
  });

  it('fallback provider serves on primary failure (secondary mock-labeled)', async () => {
    const failing = new FakePrimary(true);
    const chain = createFallbackProvider(failing, new StubSecondSerpProvider());
    const metrics = await chain.keywordMetrics(['some keyword']);
    expect(metrics[0].volume).not.toBeNull();
    expect(chain.lastServedBy).toBe('stub-second-provider');
    expect(chain.isMock).toBe(true); // mock-labeled stub
  });

  it('detectRankAnomaly: |delta|>=10 flags; calm history does not', () => {
    const flagged = detectRankAnomaly([25, 8, 7, 9, 8, 7, 8]);
    expect(flagged.anomaly).toBe(true);
    const calm = detectRankAnomaly([5, 5, 6, 5, 6, 5, 6, 5]);
    expect(calm.anomaly).toBe(false);
    const zflag = detectRankAnomaly([30, 8, 8, 8, 8, 8, 8]);
    expect(zflag.anomaly).toBe(true);
  });

  it('scanKeywordAnomaly persists an anomaly alert row (deduped per day)', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    const s = await app.inject({ method: 'POST', url: '/api/v1/sites', headers: auth(u.token), payload: { domain: `anom-${Date.now()}.com` } });
    const siteId = (s.json() as any).id as string;
    const kw = (await query(`INSERT INTO keywords (id,tenant_id,site_id,keyword,tracked) VALUES (gen_random_uuid(),$1,$2,'anom kw',TRUE) RETURNING id`, [u.tenantId, siteId])).rows[0].id as string;
    // History (oldest -> newest): steady at ~8, then a crash to 40 on the latest check.
    const hist: number[] = [8, 8, 9, 8, 7, 8, 8, 40];
    for (let i = 0; i < hist.length; i++) {
      await query(`INSERT INTO rank_checks (id,tenant_id,keyword_id,position,checked_at) VALUES (gen_random_uuid(),$1,$2,$3, now() - ($4 || ' days')::interval)`,
        [u.tenantId, kw, hist[i], String(hist.length - i)]);
    }
    const res = await scanKeywordAnomaly(u.tenantId, siteId, kw);
    expect(res.anomaly).toBe(true);
    const alerts = (await query(`SELECT anomaly, z_score, anomaly_reason FROM rank_alerts WHERE tenant_id=$1 AND keyword_id=$2 AND anomaly=TRUE`, [u.tenantId, kw])).rows;
    expect(alerts.length).toBe(1);
    expect(alerts[0].anomaly_reason).toBeTruthy();
    // Second scan same day: no duplicate.
    await scanKeywordAnomaly(u.tenantId, siteId, kw);
    const alerts2 = (await query(`SELECT COUNT(*)::int c FROM rank_alerts WHERE tenant_id=$1 AND keyword_id=$2 AND anomaly=TRUE`, [u.tenantId, kw])).rows[0].c;
    expect(Number(alerts2)).toBe(1);
  });
});
