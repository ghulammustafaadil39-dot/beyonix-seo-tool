// Backend-B Wave 2 unit tests — C-04 pure services.
// No network, no DB, no Redis.
import { describe, it, expect } from 'vitest';
import {
  parseRobotsTxt, matchingGroups, isAllowedUrl, crawlDelayFor, sitemapUrlsFromRobots,
} from '../src/services/robotsParser.js';
import { HostPoliteness } from '../src/services/politeness.js';
import { simhash64, hammingDistance, isNearDuplicate, clusterNearDuplicates } from '../src/services/simhash.js';
import { validateJsonLd } from '../src/services/structuredData.js';
import { parseSitemapXml, findOrphanPages } from '../src/services/sitemap.js';
import { impactScore, diffIssues } from '../src/services/auditDiff.js';

describe('robotsParser', () => {
  const TXT = `
User-agent: *
Disallow: /private/
Crawl-delay: 2

User-agent: BeyonixSEO-Bot
Disallow: /secret/
Allow: /secret/public
Crawl-delay: 5

Sitemap: https://example.com/sitemap.xml
`;

  it('parses per-user-agent groups', () => {
    const groups = parseRobotsTxt(TXT);
    expect(groups).toHaveLength(2);
    expect(groups[0].userAgents).toEqual(['*']);
    expect(groups[0].disallows).toEqual(['/private/']);
    expect(groups[0].crawlDelay).toBe(2);
    expect(groups[1].userAgents).toEqual(['beyonixseo-bot']);
    expect(groups[1].allows).toEqual(['/secret/public']);
  });

  it('matches specific group over wildcard', () => {
    const groups = parseRobotsTxt(TXT);
    const m = matchingGroups(groups, 'BeyonixSEO-Bot/1.0');
    expect(m).toHaveLength(1);
    expect(m[0].userAgents).toEqual(['beyonixseo-bot']);
    const w = matchingGroups(groups, 'SomeOtherBot/2.0');
    expect(w).toHaveLength(1);
    expect(w[0].userAgents).toEqual(['*']);
  });

  it('longest match wins; allow beats disallow on tie', () => {
    const groups = parseRobotsTxt(TXT);
    expect(isAllowedUrl(groups, 'BeyonixSEO-Bot/1.0', 'https://example.com/secret/x')).toBe(false);
    expect(isAllowedUrl(groups, 'BeyonixSEO-Bot/1.0', 'https://example.com/secret/public')).toBe(true);
    expect(isAllowedUrl(groups, 'Other/1.0', 'https://example.com/private/x')).toBe(false);
    expect(isAllowedUrl(groups, 'Other/1.0', 'https://example.com/blog')).toBe(true);
  });

  it('honors crawl-delay per crawler', () => {
    const groups = parseRobotsTxt(TXT);
    expect(crawlDelayFor(groups, 'BeyonixSEO-Bot/1.0')).toBe(5);
    expect(crawlDelayFor(groups, 'Other/1.0')).toBe(2);
    expect(crawlDelayFor(parseRobotsTxt('User-agent: *\nDisallow:\n'), 'X/1')).toBeNull();
  });

  it('starts a new group when user-agent follows rules', () => {
    const groups = parseRobotsTxt('User-agent: a\nDisallow: /x/\nUser-agent: b\nDisallow: /y/\n');
    expect(groups).toHaveLength(2);
    expect(groups[1].disallows).toEqual(['/y/']);
  });

  it('extracts sitemap urls from robots', () => {
    expect(sitemapUrlsFromRobots(TXT)).toEqual(['https://example.com/sitemap.xml']);
  });
});

describe('HostPoliteness', () => {
  it('enforces a minimum gap between fetches to the same host', async () => {
    const p = new HostPoliteness(50);
    const t0 = Date.now();
    await p.waitForHost('example.com');
    await p.waitForHost('example.com');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
  });

  it('does not delay different hosts', async () => {
    const p = new HostPoliteness(200);
    const t0 = Date.now();
    await p.waitForHost('a.com');
    await p.waitForHost('b.com');
    expect(Date.now() - t0).toBeLessThan(150);
  });
});

describe('simhash', () => {
  const doc = 'the quick brown fox jumps over the lazy dog near the river bank';
  it('is stable for identical text', () => {
    expect(simhash64(doc)).toBe(simhash64(doc));
    expect(hammingDistance(simhash64(doc), simhash64(doc))).toBe(0);
  });
  it('detects near-duplicates, rejects unrelated text', () => {
    const near = 'the quick brown fox jumps over the lazy dog near the river bank today';
    const far = 'quantum entanglement enables instantaneous correlation across vast interstellar distances';
    expect(isNearDuplicate(simhash64(doc), simhash64(near))).toBe(true);
    expect(isNearDuplicate(simhash64(doc), simhash64(far))).toBe(false);
  });
  it('clusters near-duplicate pages', () => {
    const pages = [
      { url: 'https://x.com/a', simhash: simhash64(doc) },
      { url: 'https://x.com/b', simhash: simhash64(doc + ' extra words here now') },
      { url: 'https://x.com/c', simhash: simhash64('completely unrelated content about rocket propulsion systems') },
    ];
    const clusters = clusterNearDuplicates(pages);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toContain('https://x.com/a');
    expect(clusters[0]).toContain('https://x.com/b');
  });
});

describe('structuredData', () => {
  it('detects types and missing required fields', () => {
    const v = validateJsonLd([
      JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article' }),
      JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [] }),
    ]);
    expect(v.types).toContain('Article');
    expect(v.types).toContain('FAQPage');
    const missing = v.issues.filter((i) => i.type === 'schema-missing-field');
    expect(missing.some((i) => i.message.includes('Article') && i.message.includes('headline'))).toBe(true);
    // FAQPage with empty mainEntity counts as missing
    expect(missing.some((i) => i.message.includes('FAQPage'))).toBe(true);
  });
  it('flags invalid JSON blocks', () => {
    const v = validateJsonLd(['{not json']);
    expect(v.hasParseErrors).toBe(true);
    expect(v.issues.some((i) => i.type === 'schema-invalid-json')).toBe(true);
  });
});

describe('sitemap', () => {
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc><lastmod>2026-10-01</lastmod></url>
  <url><loc>https://example.com/about</loc></url>
</urlset>`;
  const IDX = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>`;

  it('parses urlset and sitemapindex', () => {
    const p = parseSitemapXml(XML);
    expect(p.urls).toHaveLength(2);
    expect(p.urls[0].lastmod).toBe('2026-10-01');
    expect(parseSitemapXml(IDX).sitemaps).toEqual(['https://example.com/s1.xml']);
  });

  it('finds orphan pages (in sitemap, neither crawled nor linked)', () => {
    const orphans = findOrphanPages(
      ['https://example.com/', 'https://example.com/about', 'https://example.com/hidden'],
      new Set(['https://example.com/']),
      new Set(['https://example.com/about']),
    );
    expect(orphans).toEqual(['https://example.com/hidden']);
  });
});

describe('auditDiff + impact', () => {
  it('diffs issue sets between crawls', () => {
    const prev = [
      { type: 'missing-title', url: 'https://x.com/a' },
      { type: 'slow-page', url: 'https://x.com/b' },
    ];
    const curr = [
      { type: 'missing-title', url: 'https://x.com/a' },
      { type: 'missing-h1', url: 'https://x.com/c' },
    ];
    const d = diffIssues(prev, curr);
    expect(d.newIssues).toHaveLength(1);
    expect(d.newIssues[0].type).toBe('missing-h1');
    expect(d.resolved).toHaveLength(1);
    expect(d.resolved[0].type).toBe('slow-page');
    expect(d.byType['missing-h1']).toEqual({ new: 1, resolved: 0 });
  });

  it('impact grows with severity and page importance', () => {
    const low = impactScore('info', 0, false);
    const high = impactScore('error', 50, true);
    expect(high).toBeGreaterThan(low);
    expect(impactScore('error', 0, false)).toBeLessThanOrEqual(100);
    expect(impactScore('error', 10000, true)).toBeLessThanOrEqual(100);
  });
});
