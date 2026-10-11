import { config, hasDataForSeo } from '../config.js';
import type { KeywordSerpProvider, KeywordMetric, SerpResult, SerpItem, SerpSnapshotResult } from './types.js';

// Deterministic pseudo-random from string seed — stable mock data.
function seeded(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/**
 * C-05: maps raw DataForSEO SERP item types to our SERP-feature vocabulary.
 * Exported for tests.
 */
export function detectSerpFeatures(itemTypes: string[]): string[] {
  const features = new Set<string>(['organic']);
  for (const t of itemTypes) {
    switch (t) {
      case 'ai_overview': features.add('ai_overview'); break;
      case 'people_also_ask': features.add('people_also_ask'); break;
      case 'featured_snippet': features.add('featured_snippet'); break;
      case 'local_pack': features.add('local_pack'); break;
      case 'knowledge_graph': features.add('knowledge_graph'); break;
      case 'top_stories': features.add('top_stories'); break;
      case 'video': features.add('video_carousel'); break;
      case 'images': features.add('image_pack'); break;
      case 'shopping': features.add('shopping'); break;
      case 'ads': features.add('ads'); break;
      case 'twitter': features.add('social_pack'); break;
      case 'related_searches': features.add('related_searches'); break;
    }
  }
  return [...features];
}

const MOCK_DOMAINS = [
  'wikipedia.org', 'example-blog.com', 'topreviews.io', 'howtogeek.example',
  'nicheguide.net', 'authorityblog.com', 'contenthub.dev', 'rankwise.co',
];

/** Deterministic full-SERP mock: `domain` lands at the seeded position (or not at all). */
function mockSerpItems(keyword: string, domain: string, depth = 100): SerpItem[] {
  const s = seeded('serp:' + keyword.toLowerCase() + '|' + domain.toLowerCase());
  const ownPos = s < 0.3 ? 1 + Math.floor(s * 99) : -1; // 30% chance of ranking
  const items: SerpItem[] = [];
  const slug = keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  for (let i = 1; i <= depth; i++) {
    if (i === ownPos) {
      items.push({
        position: i,
        url: `https://${domain}/${slug}`,
        domain,
        title: `${keyword} — ${domain}`,
        itemType: 'organic',
      });
    } else {
      const d = MOCK_DOMAINS[Math.floor(seeded(`md:${keyword}:${i}`) * MOCK_DOMAINS.length)];
      items.push({
        position: i,
        url: `https://${d}/${slug}-${i}`,
        domain: d,
        title: `${keyword} guide part ${i}`,
        itemType: 'organic',
      });
    }
  }
  return items;
}

export class MockDataForSEO implements KeywordSerpProvider {
  name = 'mock-dataforseo';
  isMock = true;
  async keywordMetrics(keywords: string[], _locationCode = 2840): Promise<KeywordMetric[]> {
    return keywords.map((keyword) => {
      const s = seeded('vol:' + keyword.toLowerCase());
      const words = keyword.trim().split(/\s+/).length;
      // longer-tail => lower volume, lower difficulty (plausible shape)
      const volume = Math.max(10, Math.round(12000 * Math.pow(s, 2) / Math.pow(words, 1.5)));
      const difficulty = Math.round(15 + seeded('diff:' + keyword.toLowerCase()) * 70);
      return { keyword, volume, difficulty };
    });
  }
  async serp(keyword: string, domain: string, _locationCode = 2840): Promise<SerpResult> {
    const s = seeded('serp:' + keyword.toLowerCase() + '|' + domain);
    const position = s < 0.25 ? Math.ceil(s * 40) : null; // sometimes ranking, sometimes not
    return {
      position,
      url: position ? `https://${domain}/${keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}` : null,
      features: s < 0.4 ? ['ai_overview', 'people_also_ask'] : ['organic'],
    };
  }
  /** C-05: deterministic full-SERP mock (labeled mock by callers). */
  async serpFull(keyword: string, domain: string, _locationCode = 2840, _device = 'desktop'): Promise<SerpSnapshotResult> {
    const items = mockSerpItems(keyword, domain);
    const s = seeded('serpfeat:' + keyword.toLowerCase());
    const features = s < 0.4
      ? ['organic', 'ai_overview', 'people_also_ask']
      : s < 0.6 ? ['organic', 'featured_snippet', 'people_also_ask'] : ['organic'];
    return { items, features };
  }
  /** Mock competitor ranked keywords (deterministic; labeled mock by callers). */
  async competitorKeywords(competitorDomain: string, locationCode = 2840): Promise<Array<{ keyword: string; position: number; url: string }>> {
    void locationCode;
    const out: Array<{ keyword: string; position: number; url: string }> = [];
    for (let i = 0; i < 25; i++) {
      out.push({
        keyword: `mock ${competitorDomain.split('.')[0]} topic ${i + 1}`,
        position: 1 + Math.floor(seeded(`ck:${competitorDomain}:${i}`) * 20),
        url: `https://${competitorDomain}/topic-${i + 1}`,
      });
    }
    return out;
  }
}

import { providerCircuit } from '../services/circuitBreaker.js';

export class DataForSEOProvider implements KeywordSerpProvider {
  name = 'dataforseo';
  isMock = false;
  private auth = 'Basic ' + Buffer.from(`${config.dataforseoLogin}:${config.dataforseoPassword}`).toString('base64');

  private async post(path: string, body: unknown): Promise<any> {
    // Outbound provider calls are circuit-broken via the canonical
    // Redis-backed breaker (Backend-A C-03): providerCircuit(name).exec(fn).
    return providerCircuit('dataforseo').exec(async () => {
      const res = await fetch(`https://api.dataforseo.com/v3${path}`, {
        method: 'POST',
        headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
        // B2-M5: 30s cap — a stalled DataForSEO call must surface as a
        // thrown error (which the breaker counts) instead of hanging the
        // worker until the job timeout.
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`DataForSEO ${path}: ${res.status} ${await res.text()}`);
      return res.json();
    });
  }

  async keywordMetrics(keywords: string[], locationCode = 2840): Promise<KeywordMetric[]> {
    if (keywords.length === 0) return [];
    const data = await this.post('/keywords_data/google_ads/search_volume/live', [
      { keywords, location_code: locationCode, language_code: 'en' },
    ]);
    const items: any[] = data?.tasks?.[0]?.result ?? [];
    const byKw = new Map(items.map((i: any) => [String(i.keyword).toLowerCase(), i]));

    // Honest organic difficulty: the Ads API's competition_index measures
    // ADVERTISER competition, not SEO difficulty. DataForSEO Labs exposes a
    // real organic keyword_difficulty (0-100) — use it. If that call fails,
    // leave difficulty null rather than showing a misleading number.
    let byDiff = new Map<string, number>();
    try {
      const diffData = await this.post('/dataforseo_labs/google/bulk_keyword_difficulty/live', [
        { keywords, location_code: locationCode, language_code: 'en' },
      ]);
      const diffResults: any[] = diffData?.tasks?.[0]?.result ?? [];
      for (const r of diffResults) {
        for (const it of r.items ?? []) {
          if (it?.keyword != null && it?.keyword_difficulty != null) {
            byDiff.set(String(it.keyword).toLowerCase(), Math.round(Number(it.keyword_difficulty)));
          }
        }
      }
    } catch (err) {
      console.warn('[dataforseo] bulk_keyword_difficulty failed, difficulty will be null:', (err as Error).message);
    }

    return keywords.map((keyword) => {
      const m = byKw.get(keyword.toLowerCase());
      return {
        keyword,
        volume: m?.search_volume ?? null,
        difficulty: byDiff.get(keyword.toLowerCase()) ?? null,
      };
    });
  }

  async serp(keyword: string, domain: string, locationCode = 2840): Promise<SerpResult> {
    const data = await this.post('/serp/google/organic/live/advanced', [
      { keyword, location_code: locationCode, language_code: 'en', depth: 100 },
    ]);
    const items: any[] = data?.tasks?.[0]?.result?.[0]?.items ?? [];
    let position: number | null = null;
    let url: string | null = null;
    const itemTypes: string[] = [];
    for (const it of items) {
      if (typeof it.type === 'string') itemTypes.push(it.type);
      if (it.type === 'organic' && position === null && it.domain === domain) {
        position = it.rank_absolute ?? it.rank_group ?? null;
        url = it.url ?? null;
      }
    }
    return { position, url, features: detectSerpFeatures(itemTypes) };
  }

  /**
   * C-05: full top-100 SERP snapshot. `device` maps to DataForSEO's
   * device parameter (desktop|mobile); rank_absolute is the pixel rank.
   */
  async serpFull(
    keyword: string,
    domain: string,
    locationCode = 2840,
    device = 'desktop',
  ): Promise<SerpSnapshotResult> {
    const data = await this.post('/serp/google/organic/live/advanced', [
      {
        keyword,
        location_code: locationCode,
        language_code: 'en',
        device: device === 'mobile' ? 'mobile' : 'desktop',
        os: device === 'mobile' ? 'android' : 'windows',
        depth: 100,
      },
    ]);
    const rawItems: any[] = data?.tasks?.[0]?.result?.[0]?.items ?? [];
    const items: SerpItem[] = [];
    const itemTypes: string[] = [];
    for (const it of rawItems) {
      if (typeof it.type === 'string') itemTypes.push(it.type);
      if (it.type !== 'organic') continue;
      const position = Number(it.rank_absolute ?? it.rank_group ?? 0);
      if (!position || position > 100) continue;
      items.push({
        position,
        url: String(it.url ?? ''),
        domain: String(it.domain ?? ''),
        title: typeof it.title === 'string' ? it.title : null,
        itemType: 'organic',
      });
    }
    items.sort((a, b) => a.position - b.position);
    return { items: items.slice(0, 100), features: detectSerpFeatures(itemTypes) };
  }
  /**
   * F-03/F-07: keywords a competitor domain ranks for (DataForSEO Labs).
   * Mock: deterministic fake list (labeled mock by callers).
   */
  async competitorKeywords(competitorDomain: string, locationCode = 2840): Promise<Array<{ keyword: string; position: number; url: string }>> {
    const data = await this.post('/dataforseo_labs/google/ranked_keywords/live', [
      { target: competitorDomain, location_code: locationCode, language_code: 'en', limit: 100 },
    ]);
    const items: any[] = data?.tasks?.[0]?.result?.[0]?.items ?? data?.tasks?.[0]?.result ?? [];
    const out: Array<{ keyword: string; position: number; url: string }> = [];
    for (const it of items) {
      if (!it?.keyword) continue;
      out.push({
        keyword: String(it.keyword),
        position: Number(it.ranked_serp_element?.serp_item?.rank_absolute ?? it.rank_absolute ?? 0) || 0,
        url: String(it.ranked_serp_element?.serp_item?.url ?? ''),
      });
    }
    return out.filter((o) => o.position > 0).slice(0, 100);
  }
}

let cached: KeywordSerpProvider | null = null;
export function getKeywordSerpProvider(): KeywordSerpProvider {
  if (hasDataForSeo()) return new DataForSEOProvider();
  if (!cached) {
    console.log('[provider] using MOCK dataforseo (no DATAFORSEO_LOGIN/PASSWORD configured)');
    cached = new MockDataForSEO();
  }
  return cached;
}
