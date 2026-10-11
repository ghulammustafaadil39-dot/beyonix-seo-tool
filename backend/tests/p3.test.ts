import { describe, it, expect, vi, beforeEach } from 'vitest';

const { meteredCalls } = vi.hoisted(() => ({
  meteredCalls: [] as Array<{ tenantId: string; kind: string; units: number }>,
}));

vi.mock('../src/metering.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/metering.js')>();
  return {
    ...orig,
    // A1-M1: the real withUsageReservation needs Postgres (plan lookup +
    // transactional reservation). These stub-DB unit tests assert service
    // logic + that metering is invoked; the double runs the work and
    // records the commit. The real machinery is covered by integration
    // tests (tests/wave4/w4-medium-1.test.ts).
    withUsageReservation: async (
      tenantId: string,
      kind: string,
      units: number,
      work: () => Promise<{ value: unknown; actualUnits?: number }>,
    ) => {
      const { value, actualUnits } = await work();
      meteredCalls.push({ tenantId, kind, units: actualUnits ?? units });
      return value;
    },
  };
});
import { classifyIntent, priorityScore } from '../src/services/keywordService.js';
import { getKeywordMetrics, getSerp } from '../src/services/keywordCache.js';
import type { QueryFn } from '../src/db.js';
import type { KeywordSerpProvider } from '../src/providers/types.js';

describe('classifyIntent', () => {
  it('flags buying/service language as transactional', () => {
    expect(classifyIntent('buy now')).toBe('transactional');
    expect(classifyIntent('plumber near me')).toBe('transactional');
    expect(classifyIntent('hire ai developers')).toBe('transactional');
    expect(classifyIntent('get a quote for roofing')).toBe('transactional');
  });
  it('flags comparison language as commercial', () => {
    expect(classifyIntent('best crm for startups')).toBe('commercial');
    expect(classifyIntent('ahrefs vs semrush')).toBe('commercial');
    expect(classifyIntent('top 10 laptops review')).toBe('commercial');
  });
  it('flags account language as navigational', () => {
    expect(classifyIntent('gmail login')).toBe('navigational');
    expect(classifyIntent('facebook sign in')).toBe('navigational');
  });
  it('falls back to informational', () => {
    expect(classifyIntent('how to bake bread')).toBe('informational');
    expect(classifyIntent('what is seo')).toBe('informational');
  });
});

describe('priorityScore', () => {
  it('rewards higher volume', () => {
    expect(priorityScore(10000, 30)).toBeGreaterThan(priorityScore(100, 30));
  });
  it('penalizes higher difficulty', () => {
    expect(priorityScore(1000, 80)).toBeLessThan(priorityScore(1000, 10));
  });
  it('returns a mid-range score for null inputs', () => {
    const s = priorityScore(null, null);
    expect(s).toBeGreaterThan(30);
    expect(s).toBeLessThan(70);
  });
  it('clamps to 1..100', () => {
    expect(priorityScore(0, 100)).toBe(1);
    expect(priorityScore(1_000_000_000, 0)).toBe(100);
  });
});

describe('keywordCache (fake QueryFn, no network/db)', () => {
  beforeEach(() => {
    meteredCalls.length = 0;
  });
  function makeProvider(): KeywordSerpProvider & {
    keywordMetrics: ReturnType<typeof vi.fn>;
    serp: ReturnType<typeof vi.fn>;
  } {
    return {
      name: 'fake',
      isMock: true,
      keywordMetrics: vi.fn(async (kws: string[]) =>
        kws.map((k) => ({ keyword: k, volume: 1200, difficulty: 35 })),
      ),
      serp: vi.fn(async (keyword: string, _domain: string) => ({
        position: 7,
        url: `https://example.com/${keyword}`,
        features: ['featured_snippet'],
      })),
    };
  }

  /** Fake DB with in-memory metrics + serp caches, recording all writes. */
  function makeDb(seedMetrics: Array<{ keyword: string; volume: number; difficulty: number }> = []) {
    const metrics = new Map(seedMetrics.map((r) => [r.keyword, r]));
    const serp = new Map<string, any>();
    const inserts: string[] = [];
    const q: QueryFn = async (text, params) => {
      if (text.includes('FROM keyword_metrics_cache')) {
        const kws = (params?.[0] as string[]) ?? [];
        const rows = kws
          .map((k) => metrics.get(k))
          .filter(Boolean)
          .map((r) => ({ keyword: r!.keyword, volume: r!.volume, difficulty: r!.difficulty }));
        return { rows, rowCount: rows.length };
      }
      if (text.includes('INSERT INTO keyword_metrics_cache')) {
        inserts.push('keyword_metrics_cache');
        const [keyword, volume, difficulty] = params as [string, number, number];
        metrics.set(keyword, { keyword, volume, difficulty });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('FROM serp_cache')) {
        const row = serp.get(params![0] as string);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (text.includes('INSERT INTO serp_cache')) {
        inserts.push('serp_cache');
        const [cache_key, position, url, serp_features] = params as [string, number, string, string];
        serp.set(cache_key, { position, url, serp_features: JSON.parse(serp_features) });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('INSERT INTO usage_events')) {
        inserts.push('usage_events');
        return { rows: [], rowCount: 1 };
      }
      // D5-L-3: global provider reserve — mock always grants (no cap in unit tests).
      if (text.includes('INSERT INTO global_provider_guard')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('INSERT INTO provider_spend')) {
        inserts.push('provider_spend');
        return { rows: [{ id: '00000000-0000-4000-8000-000000000000' }], rowCount: 1 };
      }
      if (text.includes('UPDATE provider_spend') || text.includes('DELETE FROM provider_spend')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    return { q, inserts };
  }

  it('metrics: cache miss hits the provider once, caches + meters; hit does not', async () => {
    const provider = makeProvider();
    const { q, inserts } = makeDb();

    const first = await getKeywordMetrics('t1', ['Buy Shoes', 'buy shoes '], q, provider);
    expect(first).toHaveLength(1); // deduped + normalized
    expect(first[0]).toMatchObject({ keyword: 'buy shoes', volume: 1200, difficulty: 35 });
    expect(provider.keywordMetrics).toHaveBeenCalledTimes(1);
    expect(inserts).toContain('keyword_metrics_cache');
    expect(meteredCalls).toHaveLength(1);
    expect(meteredCalls[0]).toMatchObject({ tenantId: 't1', kind: 'keyword_metrics' });

    provider.keywordMetrics.mockClear();
    const second = await getKeywordMetrics('t1', ['buy shoes'], q, provider);
    expect(second).toHaveLength(1);
    expect(provider.keywordMetrics).not.toHaveBeenCalled(); // served from cache
  });

  it('metrics: cached row returned verbatim without provider call', async () => {
    const provider = makeProvider();
    const { q } = makeDb([{ keyword: 'seo tools', volume: 800, difficulty: 20 }]);
    const res = await getKeywordMetrics('t1', ['seo tools'], q, provider);
    expect(res[0]).toMatchObject({ keyword: 'seo tools', volume: 800, difficulty: 20 });
    expect(provider.keywordMetrics).not.toHaveBeenCalled();
  });

  it('serp: cache miss hits provider once and caches; hit does not', async () => {
    const provider = makeProvider();
    const { q, inserts } = makeDb();

    const first = await getSerp('t1', 'buy shoes', 'example.com', q, provider);
    expect(first.position).toBe(7);
    expect(provider.serp).toHaveBeenCalledTimes(1);
    expect(inserts).toContain('serp_cache');

    provider.serp.mockClear();
    const second = await getSerp('t1', 'buy shoes', 'example.com', q, provider);
    expect(second.position).toBe(7);
    expect(provider.serp).not.toHaveBeenCalled();
  });

  it('metrics: empty keyword list returns [] without provider/db work', async () => {
    const provider = makeProvider();
    const { q, inserts } = makeDb();
    expect(await getKeywordMetrics('t1', ['  ', ''], q, provider)).toEqual([]);
    expect(provider.keywordMetrics).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });
});
