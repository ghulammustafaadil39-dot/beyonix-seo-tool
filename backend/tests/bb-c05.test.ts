// Backend-B Wave 2 — C-05 rank tracking v2 tests.
// Pure logic + snapshot cache against a stub QueryFn (no real DB).
// Redis coalescing degrades gracefully when Redis is unreachable.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/queues.js', () => ({
  QUEUES: { rankCheck: 'rank-check' },
  Jobs: { RANK_CHECK: 'rank-check' },
  enqueue: vi.fn(async () => ({ id: 'mock-job' })),
  checkTenantRateLimit: vi.fn(async () => true),
}));

import { detectSerpFeatures, MockDataForSEO } from '../src/providers/dataforseo.js';
import {
  getSerpSnapshot, findOwnPosition, snapshotCacheKey,
} from '../src/services/serpSnapshots.js';
import {
  positionVisibility, siteVisibilityShare, competitorPositions,
} from '../src/services/rankMetrics.js';
import { resolveTrackingConfig } from '../src/services/rankJobs.js';
import type { QueryFn } from '../src/db.js';

/** Minimal in-memory QueryFn stub for serp_snapshots + usage_events. */
function stubQuery(): { q: QueryFn; calls: { sql: string; params: unknown[] }[]; snapshots: Map<string, any> } {
  const snapshots = new Map<string, any>();
  const calls: { sql: string; params: unknown[] }[] = [];
  const q = (async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM serp_snapshots') && sql.includes('WHERE cache_key')) {
      const row = snapshots.get(params[0] as string);
      const fresh = row && Date.now() - new Date(row.fetched_at).getTime() < 7 * 86400_000;
      return { rows: fresh ? [row] : [], rowCount: fresh ? 1 : 0 };
    }
    if (sql.startsWith('INSERT INTO serp_snapshots')) {
      const row = {
        id: `snap-${snapshots.size + 1}`,
        cache_key: params[0], keyword: params[1], location_code: params[2],
        device: params[3], language: params[4], fetched_at: new Date().toISOString(),
        items: JSON.parse(params[5] as string), features: JSON.parse(params[6] as string),
      };
      snapshots.set(params[0] as string, row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as unknown as QueryFn;
  return { q, calls, snapshots };
}

const mockProvider = new MockDataForSEO();

describe('detectSerpFeatures', () => {
  it('maps DataForSEO item types to the feature vocabulary', () => {
    const f = detectSerpFeatures(['organic', 'ai_overview', 'featured_snippet', 'local_pack', 'video', 'ads']);
    expect(f).toContain('ai_overview');
    expect(f).toContain('featured_snippet');
    expect(f).toContain('local_pack');
    expect(f).toContain('video_carousel');
    expect(f).toContain('ads');
    expect(f).toContain('organic');
  });
  it('always includes organic', () => {
    expect(detectSerpFeatures([])).toEqual(['organic']);
  });
});

describe('findOwnPosition', () => {
  it('finds the domain (www-normalized) or reports not-ranked', () => {
    const items = [
      { position: 1, url: 'https://a.com/x', domain: 'a.com', title: null, itemType: 'organic' },
      { position: 2, url: 'https://www.mine.com/p', domain: 'www.mine.com', title: null, itemType: 'organic' },
    ];
    expect(findOwnPosition(items, 'mine.com')).toEqual({ position: 2, url: 'https://www.mine.com/p' });
    expect(findOwnPosition(items, 'other.com')).toEqual({ position: null, url: null });
  });
});

describe('snapshotCacheKey', () => {
  it('is tenant-independent (shared cross-tenant cache)', () => {
    expect(snapshotCacheKey('SEO Audit', 2840, 'desktop', 'en'))
      .toBe(snapshotCacheKey('seo audit ', 2840, 'desktop', 'en'));
  });
});

describe('getSerpSnapshot', () => {
  it('fetches on miss, meters the tenant, then serves cross-tenant hits free', async () => {
    const { q, calls } = stubQuery();
    const fetchSpy = vi.spyOn(mockProvider, 'serpFull');
    // Tenant A: miss -> provider called, usage recorded.
    const a = await getSerpSnapshot('tenant-a', 'seo audit', 'mine.com', {}, q, mockProvider);
    expect(a.cached).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const usageCalls = calls.filter((c) => c.sql.includes('INSERT INTO usage_events'));
    expect(usageCalls).toHaveLength(1);
    expect(usageCalls[0].params[0]).toBe('tenant-a');
    // Tenant B, same keyword/location: HIT -> no provider call, no usage.
    const b = await getSerpSnapshot('tenant-b', 'seo audit', 'other.com', {}, q, mockProvider);
    expect(b.cached).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.sql.includes('INSERT INTO usage_events'))).toHaveLength(1);
    // Same own-domain position logic works for tenant B's domain.
    expect(typeof b.notRanked).toBe('boolean');
  });

  it('handles not-in-top-100 (position null)', async () => {
    const { q } = stubQuery();
    // Mock ranks the domain only 30% of the time; pick a keyword+domain and
    // assert the notRanked flag is coherent with the position.
    const r = await getSerpSnapshot('tenant-a', 'some very obscure keyword xyz', 'mine.com', {}, q, mockProvider);
    expect(r.notRanked).toBe(r.position === null);
    expect(r.pixelRank).toBe(r.position);
  });
});

describe('rankMetrics', () => {
  it('positionVisibility decays with position; null = 0', () => {
    expect(positionVisibility(1)).toBe(100);
    expect(positionVisibility(3)).toBeGreaterThan(positionVisibility(10));
    expect(positionVisibility(null)).toBe(0);
    expect(positionVisibility(101)).toBe(1);
  });
  it('siteVisibilityShare averages visibility and avg position', () => {
    const s = siteVisibilityShare([
      { keywordId: '1', keyword: 'a', position: 1, notRanked: false, visibility: positionVisibility(1) },
      { keywordId: '2', keyword: 'b', position: null, notRanked: true, visibility: positionVisibility(null) },
    ]);
    expect(s.total).toBe(2);
    expect(s.ranked).toBe(1);
    expect(s.avgPosition).toBe(1);
    expect(s.visibilityShare).toBe(50);
  });
  it('competitorPositions reads rivals from the same snapshot', () => {
    const items = [
      { position: 1, domain: 'rival.com' },
      { position: 5, domain: 'www.mine.com' },
    ];
    const pos = competitorPositions(items, ['rival.com', 'ghost.com']);
    expect(pos['rival.com']).toBe(1);
    expect(pos['ghost.com']).toBeNull();
  });
});

describe('resolveTrackingConfig', () => {
  it('falls back to site location and defaults', () => {
    expect(resolveTrackingConfig(null, 2826)).toEqual({ device: 'desktop', locationCode: 2826, language: 'en' });
    expect(resolveTrackingConfig({ device: 'mobile', location_code: 0, language: '' }, 2840))
      .toEqual({ device: 'mobile', locationCode: 2840, language: 'en' });
  });
});
