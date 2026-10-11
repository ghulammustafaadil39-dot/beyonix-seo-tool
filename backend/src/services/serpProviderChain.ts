import type { KeywordMetric, KeywordSerpProvider, SerpResult, SerpSnapshotResult } from '../providers/types.js';

// W-02: multi-provider fallback behind the existing KeywordSerpProvider
// interface. Primary = DataForSEO (real factory in providers/dataforseo.ts).
// Secondary = an explicit STUB: it is mock-labeled (isMock = true, name
// 'stub-second-provider') and returns deterministic synthetic data — it
// exists so the fallback path is real, tested code, not a promise. Swap in
// a real second provider by implementing the same interface.

export class StubSecondSerpProvider implements KeywordSerpProvider {
  name = 'stub-second-provider';
  isMock = true;
  async keywordMetrics(keywords: string[]): Promise<KeywordMetric[]> {
    return keywords.map((k) => ({ keyword: k, volume: 100 + (k.length * 37) % 900, difficulty: 10 + (k.length * 13) % 60 }));
  }
  async serp(keyword: string, domain: string): Promise<SerpResult> {
    void keyword; void domain;
    return { position: null, url: null, features: [] };
  }
}

export class FallbackSerpProvider implements KeywordSerpProvider {
  name: string;
  isMock: boolean;
  /** name of the provider that served the most recent call (provenance). */
  lastServedBy: string;
  constructor(private primary: KeywordSerpProvider, private secondary: KeywordSerpProvider) {
    this.name = `fallback(${primary.name}->${secondary.name})`;
    this.isMock = primary.isMock && secondary.isMock;
    this.lastServedBy = primary.name;
  }
  private async run<T>(fn: (p: KeywordSerpProvider) => Promise<T>): Promise<T> {
    try {
      const out = await fn(this.primary);
      this.lastServedBy = this.primary.name;
      this.isMock = this.primary.isMock;
      return out;
    } catch {
      const out = await fn(this.secondary);
      this.lastServedBy = this.secondary.name;
      this.isMock = this.secondary.isMock;
      return out;
    }
  }
  keywordMetrics(keywords: string[], locationCode?: number): Promise<KeywordMetric[]> {
    return this.run((p) => p.keywordMetrics(keywords, locationCode));
  }
  serp(keyword: string, domain: string, locationCode?: number): Promise<SerpResult> {
    return this.run((p) => p.serp(keyword, domain, locationCode));
  }
  async serpFull(keyword: string, domain: string, locationCode?: number, device?: string): Promise<SerpSnapshotResult> {
    return this.run((p) => (p.serpFull ? p.serpFull(keyword, domain, locationCode, device) : p.serp(keyword, domain, locationCode).then((s) => ({
      items: s.position ? [{ position: s.position, url: s.url ?? '', domain, title: null, itemType: 'organic' }] : [],
      features: s.features,
    }))));
  }
}

export function createFallbackProvider(primary: KeywordSerpProvider, secondary: KeywordSerpProvider = new StubSecondSerpProvider()): FallbackSerpProvider {
  return new FallbackSerpProvider(primary, secondary);
}
