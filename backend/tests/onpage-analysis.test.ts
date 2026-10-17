// Phase 8 unit tests — onpageAnalysis pure scoring (no DB, no network).
import { describe, it, expect } from 'vitest';
import {
  analyzePageRow,
  gradeFor,
  type CrawledPageRow,
} from '../src/services/onpageAnalysis.js';

function baseRow(over: Partial<CrawledPageRow> = {}): CrawledPageRow {
  return {
    url: 'https://example.com/page',
    status_code: 200,
    title: 'A Perfectly Good Title For This Test Page SEO',
    word_count: 1200,
    load_ms: 400,
    canonical: 'https://example.com/page',
    hreflangs: JSON.stringify([]),
    inlinks: 5,
    outlinks: JSON.stringify(['https://example.com/a', 'https://example.com/b']),
    images: JSON.stringify([{ src: 'a.jpg', alt: 'A descriptive alt' }]),
    meta_description:
      'This is a good meta description that is long enough for Google to show properly in the search results page.',
    h1s: JSON.stringify(['Main Heading Here']),
    robots_noindex: false,
    schema_types: JSON.stringify(['Article']),
    has_og_tags: true,
    has_faq_schema: false,
    has_article_schema: true,
    ...over,
  };
}

const PEERS = { titleCounts: new Map<string, number>(), metaCounts: new Map<string, number>() };

describe('gradeFor', () => {
  it('maps score bands to grades', () => {
    expect(gradeFor(100)).toBe('A');
    expect(gradeFor(85)).toBe('A');
    expect(gradeFor(84)).toBe('B');
    expect(gradeFor(70)).toBe('B');
    expect(gradeFor(69)).toBe('C');
    expect(gradeFor(55)).toBe('C');
    expect(gradeFor(54)).toBe('D');
    expect(gradeFor(40)).toBe('D');
    expect(gradeFor(39)).toBe('F');
    expect(gradeFor(0)).toBe('F');
  });
});

describe('analyzePageRow', () => {
  it('scores a well-optimized page highly', () => {
    const a = analyzePageRow(baseRow(), PEERS);
    expect(a.score).toBeGreaterThanOrEqual(85);
    expect(a.grade).toBe('A');
    expect(a.checks).toHaveLength(8);
    expect(a.checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('fails missing title, missing meta, thin content', () => {
    const a = analyzePageRow(
      baseRow({ title: null, meta_description: null, word_count: 50 }),
      PEERS,
    );
    const byKey = Object.fromEntries(a.checks.map((c) => [c.key, c]));
    expect(byKey.title.status).toBe('fail');
    expect(byKey.meta.status).toBe('fail');
    expect(byKey.content.status).toBe('fail');
    expect(a.score).toBeLessThan(55);
  });

  it('warns on multiple H1s', () => {
    const a = analyzePageRow(
      baseRow({ h1s: JSON.stringify(['First', 'Second']) }),
      PEERS,
    );
    const h1 = a.checks.find((c) => c.key === 'h1')!;
    expect(h1.status).toBe('warn');
    expect(h1.detail).toContain('2 H1');
  });

  it('fails on missing H1', () => {
    const a = analyzePageRow(baseRow({ h1s: JSON.stringify([]) }), PEERS);
    const h1 = a.checks.find((c) => c.key === 'h1')!;
    expect(h1.status).toBe('fail');
  });

  it('detects duplicate titles across the audit', () => {
    const peers = {
      titleCounts: new Map([['a perfectly good title for this test page seo', 3]]),
      metaCounts: new Map<string, number>(),
    };
    const a = analyzePageRow(baseRow(), peers);
    const title = a.checks.find((c) => c.key === 'title')!;
    expect(title.status).toBe('warn');
    expect(title.detail).toContain('duplicate');
  });

  it('flags images missing alt text', () => {
    const a = analyzePageRow(
      baseRow({
        images: JSON.stringify([
          { src: 'a.jpg', alt: '' },
          { src: 'b.jpg', alt: '' },
          { src: 'c.jpg', alt: '' },
          { src: 'd.jpg', alt: '' },
        ]),
      }),
      PEERS,
    );
    const img = a.checks.find((c) => c.key === 'images')!;
    expect(img.status).toBe('fail');
    expect(img.detail).toContain('4');
  });

  it('fails technical check on robots noindex', () => {
    const a = analyzePageRow(baseRow({ robots_noindex: true }), PEERS);
    const tech = a.checks.find((c) => c.key === 'technical')!;
    expect(tech.status).toBe('fail');
    expect(tech.detail).toContain('noindex');
    expect(tech.fix).toContain('noindex hatao');
  });

  it('warns when no schema markup present', () => {
    const a = analyzePageRow(
      baseRow({ schema_types: JSON.stringify([]), has_faq_schema: false, has_article_schema: false }),
      PEERS,
    );
    const schema = a.checks.find((c) => c.key === 'schema')!;
    expect(schema.status).toBe('warn');
    expect(schema.points).toBe(0);
  });

  it('warns on orphan page (no inlinks, no outlinks)', () => {
    const a = analyzePageRow(
      baseRow({ inlinks: 0, outlinks: JSON.stringify([]) }),
      PEERS,
    );
    const links = a.checks.find((c) => c.key === 'links')!;
    expect(links.status).toBe('warn');
  });

  it('parses h1s/images supplied as objects (not JSON strings)', () => {
    const a = analyzePageRow(
      baseRow({
        h1s: ['Direct Heading'],
        images: [{ src: 'x.jpg', alt: 'ok' }],
        outlinks: ['https://example.com/y'],
        schema_types: ['FAQPage'],
      } as any),
      PEERS,
    );
    const h1 = a.checks.find((c) => c.key === 'h1')!;
    expect(h1.status).toBe('pass');
    const schema = a.checks.find((c) => c.key === 'schema')!;
    expect(schema.status).toBe('pass');
  });

  it('total score always sums to 100 max', () => {
    const max = analyzePageRow(baseRow(), PEERS).checks.reduce((s, c) => s + c.max, 0);
    expect(max).toBe(100);
  });
});
