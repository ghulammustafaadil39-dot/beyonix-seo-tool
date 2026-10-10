import { config, hasDataForSeo } from '../config.js';
import type { KeywordSerpProvider, KeywordMetric, SerpResult } from './types.js';

// Deterministic pseudo-random from string seed — stable mock data.
function seeded(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
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
}

export class DataForSEOProvider implements KeywordSerpProvider {
  name = 'dataforseo';
  isMock = false;
  private auth = 'Basic ' + Buffer.from(`${config.dataforseoLogin}:${config.dataforseoPassword}`).toString('base64');

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`https://api.dataforseo.com/v3${path}`, {
      method: 'POST',
      headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`DataForSEO ${path}: ${res.status} ${await res.text()}`);
    return res.json();
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
    const features = new Set<string>();
    for (const it of items) {
      if (it.type === 'ai_overview') features.add('ai_overview');
      if (it.type === 'people_also_ask') features.add('people_also_ask');
      if (it.type === 'organic' && position === null && it.domain === domain) {
        position = it.rank_absolute ?? it.rank_group ?? null;
        url = it.url ?? null;
      }
    }
    return { position, url, features: [...features, 'organic'] };
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
