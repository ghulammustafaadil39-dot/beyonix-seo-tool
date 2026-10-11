// Sitemap.xml parsing (C-04).
// Parses urlset and sitemapindex documents (cheerio in XML mode).
// Pure — callers fetch via safeFetch. Used for orphan-page detection and
// sitemap-vs-crawl reconciliation.

import * as cheerio from 'cheerio';

export interface SitemapUrl {
  loc: string;
  lastmod: string | null;
}

export interface ParsedSitemap {
  /** page URLs (urlset) */
  urls: SitemapUrl[];
  /** nested sitemap URLs (sitemapindex) */
  sitemaps: string[];
}

/** Parse one sitemap XML document. Never throws (returns empty on garbage). */
export function parseSitemapXml(xml: string): ParsedSitemap {
  const out: ParsedSitemap = { urls: [], sitemaps: [] };
  try {
    const $ = cheerio.load(xml, { xml: true });
    $('url > loc').each((_, el) => {
      const loc = $(el).text().trim();
      if (!loc) return;
      const lastmod = $(el).parent().find('lastmod').first().text().trim() || null;
      out.urls.push({ loc, lastmod });
    });
    $('sitemap > loc').each((_, el) => {
      const loc = $(el).text().trim();
      if (loc) out.sitemaps.push(loc);
    });
  } catch {
    /* malformed XML -> empty result */
  }
  return out;
}

/**
 * Pure orphan detection: sitemap URLs that no crawled page links to AND that
 * were not themselves crawled (unreachable from the site's link graph).
 * `linked` = every internal URL seen as a link target during the crawl.
 */
export function findOrphanPages(
  sitemapUrls: string[],
  crawledUrls: Set<string>,
  linkedTargets: Set<string>,
): string[] {
  const normalize = (u: string): string => {
    try {
      const x = new URL(u);
      x.hash = '';
      return x.href;
    } catch {
      return u;
    }
  };
  const crawled = new Set([...crawledUrls].map(normalize));
  const linked = new Set([...linkedTargets].map(normalize));
  const orphans: string[] = [];
  for (const s of sitemapUrls) {
    const n = normalize(s);
    if (!crawled.has(n) && !linked.has(n)) orphans.push(s);
  }
  return [...new Set(orphans)];
}
