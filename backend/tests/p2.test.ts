// P2 tests: crawler analysis, audit rules, scoring, idempotency helper, isoWeekKey.
// No network, no DB, no redis — queues.js is mocked so importing crawlJobs/routes is safe.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/queues.js', () => ({
  QUEUES: { crawl: 'crawl', rankCheck: 'rank-check' },
  Jobs: { CRAWL_SITE: 'crawl-site', LIGHT_CHECK: 'light-check' },
  enqueue: vi.fn(async () => ({ id: 'mock-job' })),
  checkTenantRateLimit: vi.fn(async () => true),
  connection: { duplicate: () => ({}) },
}));

import { analyzePage, type AnalyzedPage } from '../src/services/crawler.js';
import { runRules, scoreFor, type RuleCtx } from '../src/services/auditRules.js';
import { shouldSkipCrawl } from '../src/services/crawlJobs.js';
import { isoWeekKey } from '../src/routes/audit.js';

const BASE = 'https://example.com/page';

function fixture(overrides: Partial<AnalyzedPage> = {}): AnalyzedPage {
  return {
    url: BASE,
    statusCode: 200,
    title: 'Example page title that is fine',
    titleLen: 31,
    metaDescription: 'A decent meta description of the page content here.',
    metaDescLen: 52,
    h1s: ['Example page title that is fine'],
    h1Count: 1,
    canonical: 'https://example.com/page',
    robotsNoindex: false,
    images: [{ src: '/a.png', alt: 'a photo' }],
    links: [],
    wordCount: 450,
    hasFaqSchema: true,
    hasArticleSchema: false,
    loadMs: 120,
    ...overrides,
  };
}

function ctxFor(pages: AnalyzedPage[], robotsFound = true, sitemapFound = true): RuleCtx {
  const titleCounts = new Map<string, number>();
  const metaDescCounts = new Map<string, number>();
  for (const p of pages) {
    const t = p.title.trim().toLowerCase();
    if (t) titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);
    const d = (p.metaDescription ?? '').trim().toLowerCase();
    if (d) metaDescCounts.set(d, (metaDescCounts.get(d) ?? 0) + 1);
  }
  return { titleCounts, metaDescCounts, robotsFound, sitemapFound };
}

describe('analyzePage', () => {
  const html = `<!DOCTYPE html><html><head>
    <meta name="robots" content="noindex, follow">
    <link rel="canonical" href="https://example.com/page">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>
    </head><body>
    <h1>Main heading</h1><h1>Second h1</h1>
    <p>${'word '.repeat(50)}</p>
    <img src="/a.png"><img src="/b.png" alt="described">
    <a href="/about">About us</a>
    <a href="https://external.com/x">External</a>
    <a href="mailto:hi@example.com">Mail</a>
    </body></html>`;

  it('handles a page with no title', () => {
    const p = analyzePage(html, BASE);
    expect(p.title).toBe('');
    expect(p.titleLen).toBe(0);
  });

  it('measures a long title', () => {
    const long = 'x'.repeat(75);
    const p = analyzePage(html.replace('</head>', `<title>${long}</title></head>`), BASE);
    expect(p.titleLen).toBe(75);
  });

  it('counts images missing alt text', () => {
    const p = analyzePage(html, BASE);
    expect(p.images).toHaveLength(2);
    const missing = p.images.filter((i) => !i.alt.trim());
    expect(missing).toHaveLength(1);
    expect(missing[0].src).toBe('/a.png');
  });

  it('extracts h1s', () => {
    const p = analyzePage(html, BASE);
    expect(p.h1s).toEqual(['Main heading', 'Second h1']);
    expect(p.h1Count).toBe(2);
  });

  it('detects FAQPage JSON-LD and noindex', () => {
    const p = analyzePage(html, BASE);
    expect(p.hasFaqSchema).toBe(true);
    expect(p.hasArticleSchema).toBe(false);
    expect(p.robotsNoindex).toBe(true);
  });

  it('resolves anchors to absolute URLs and marks internal links', () => {
    const p = analyzePage(html, BASE);
    const about = p.links.find((l) => l.href === '/about');
    expect(about).toBeDefined();
    expect(about!.absolute).toBe('https://example.com/about');
    expect(about!.internal).toBe(true);
    expect(about!.text).toBe('About us');
    const ext = p.links.find((l) => l.href === 'https://external.com/x');
    expect(ext!.internal).toBe(false);
    expect(p.links.some((l) => l.href.startsWith('mailto:'))).toBe(false);
  });

  it('counts words from body text', () => {
    const p = analyzePage(html, BASE);
    expect(p.wordCount).toBeGreaterThan(50);
  });
});

describe('runRules', () => {
  it('flags missing title as an error', () => {
    const page = fixture({ title: '', titleLen: 0 });
    const issues = runRules([page], [], ctxFor([page]));
    const hit = issues.filter((i) => i.type === 'missing-title');
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe('error');
    expect(hit[0].fix_suggestion.length).toBeGreaterThan(0);
  });

  it('flags duplicate titles on both pages as warnings', () => {
    const a = fixture({ url: 'https://example.com/a', title: 'Same Title', titleLen: 10 });
    const b = fixture({ url: 'https://example.com/b', title: 'Same Title', titleLen: 10 });
    const issues = runRules([a, b], [], ctxFor([a, b]));
    const dups = issues.filter((i) => i.type === 'duplicate-title');
    expect(dups).toHaveLength(2);
    expect(dups.every((d) => d.severity === 'warning')).toBe(true);
  });

  it('turns broken links into error issues', () => {
    const page = fixture();
    const issues = runRules(
      [page],
      [
        { from: page.url, to: 'https://example.com/gone', status: 404 },
        { from: page.url, to: 'https://example.com/timeout', status: 0 },
      ],
      ctxFor([page]),
    );
    const broken = issues.filter((i) => i.type === 'broken-link');
    expect(broken).toHaveLength(2);
    expect(broken.every((b) => b.severity === 'error')).toBe(true);
    expect(broken[0].detail).toContain('404');
    expect(broken[1].detail).toContain('network error');
  });

  it('emits missing-robots / missing-sitemap only once per site', () => {
    const a = fixture({ url: 'https://example.com/a' });
    const b = fixture({ url: 'https://example.com/b' });
    const issues = runRules([a, b], [], ctxFor([a, b], false, false));
    expect(issues.filter((i) => i.type === 'missing-robots')).toHaveLength(1);
    expect(issues.filter((i) => i.type === 'missing-sitemap')).toHaveLength(1);
  });

  it('skips content rules for non-200 pages', () => {
    const page = fixture({ statusCode: 404, title: '', titleLen: 0 });
    const issues = runRules([page], [], ctxFor([page]));
    expect(issues.filter((i) => i.type === 'missing-title')).toHaveLength(0);
  });

  it('flags the GEO no-faq-schema rule with AI-answer guidance', () => {
    const page = fixture({ hasFaqSchema: false });
    const issues = runRules([page], [], ctxFor([page]));
    const hit = issues.filter((i) => i.type === 'no-faq-schema');
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe('info');
    expect(hit[0].fix_suggestion).toContain('eligible for AI answers');
  });
});

describe('scoreFor', () => {
  it('deducts 10/4/1 per severity', () => {
    expect(scoreFor([{ severity: 'error' }, { severity: 'warning' }, { severity: 'info' }])).toBe(85);
  });

  it('caps the deduction at 90 (floors score at 10)', () => {
    const issues = Array.from({ length: 20 }, () => ({ severity: 'error' }));
    expect(scoreFor(issues)).toBe(10);
  });

  it('never goes below 0', () => {
    const issues = Array.from({ length: 100 }, () => ({ severity: 'error' }));
    expect(scoreFor(issues)).toBeGreaterThanOrEqual(0);
  });

  it('scores a clean site at 100', () => {
    expect(scoreFor([])).toBe(100);
  });
});

describe('shouldSkipCrawl', () => {
  it('returns true when a running audit exists', () => {
    expect(shouldSkipCrawl([{ status: 'running', started_at: new Date() }])).toBe(true);
  });

  it('returns true when a queued audit exists', () => {
    expect(shouldSkipCrawl([{ status: 'queued', started_at: null }])).toBe(true);
  });

  it('returns false for done/failed audits or an empty list', () => {
    expect(shouldSkipCrawl([{ status: 'done', started_at: new Date() }])).toBe(false);
    expect(shouldSkipCrawl([{ status: 'failed', started_at: new Date() }])).toBe(false);
    expect(shouldSkipCrawl([])).toBe(false);
  });

  it('returns true if any one of several is active', () => {
    expect(
      shouldSkipCrawl([
        { status: 'done', started_at: new Date() },
        { status: 'queued', started_at: new Date() },
      ]),
    ).toBe(true);
  });
});

describe('isoWeekKey', () => {
  it('matches YYYY-Www format', () => {
    expect(isoWeekKey()).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('computes the correct ISO week for a known Saturday', () => {
    // 2026-10-10 is a Saturday in ISO week 41 of 2026
    expect(isoWeekKey(new Date(2026, 9, 10))).toBe('2026-W41');
  });

  it('handles year boundaries (2021-01-01 belongs to 2020-W53)', () => {
    expect(isoWeekKey(new Date(2021, 0, 1))).toBe('2020-W53');
  });
});
