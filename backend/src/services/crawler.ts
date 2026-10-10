// Site crawler for the technical SEO audit (P2).
// - analyzePage: PURE html -> structured page data (no network), unit-testable.
// - crawlSite: same-origin BFS crawl with robots.txt respect, concurrency 4,
//   per-fetch 8s timeout, broken-link verification.

import * as cheerio from 'cheerio';
import { safeFetch } from './safeFetch.js';

export interface CrawledImage {
  src: string;
  alt: string;
}

export interface CrawledLink {
  href: string;
  absolute: string;
  internal: boolean;
  text: string;
}

export interface AnalyzedPage {
  url: string;
  statusCode: number;
  title: string;
  titleLen: number;
  metaDescription: string | null;
  metaDescLen: number;
  h1s: string[];
  h1Count: number;
  canonical: string | null;
  robotsNoindex: boolean;
  images: CrawledImage[];
  links: CrawledLink[];
  wordCount: number;
  hasFaqSchema: boolean;
  hasArticleSchema: boolean;
  viewport: string | null;
  hasOgTags: boolean;
  loadMs: number;
}

export interface BrokenLink {
  from: string;
  to: string;
  status: number; // HTTP status, or 0 on network error
}

export interface CrawlResult {
  pages: AnalyzedPage[];
  brokenLinks: BrokenLink[];
  robotsFound: boolean;
  sitemapFound: boolean;
}

export interface CrawlOpts {
  maxPages: number;
  onPage?: (n: number) => void;
}

const FETCH_TIMEOUT_MS = 8000;
const CONCURRENCY = 4;
const CRAWLER_UA = 'BeyonixSEO-Bot/1.0 (+https://beyonixsolutions.com)';

// ---------- pure analysis ----------

function collectJsonLdTypes(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectJsonLdTypes(n, out);
    return;
  }
  if (node && typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    const t = rec['@type'];
    if (typeof t === 'string') out.add(t);
    else if (Array.isArray(t)) {
      for (const x of t) if (typeof x === 'string') out.add(x);
    }
    for (const v of Object.values(rec)) collectJsonLdTypes(v, out);
  }
}

/** PURE: parse a fetched HTML document into structured page data. No network. */
export function analyzePage(html: string, url: string): AnalyzedPage {
  const $ = cheerio.load(html);

  const title = $('title').first().text().trim();
  const metaDescription =
    $('meta[name="description"]').first().attr('content')?.trim() || null;
  const h1s = $('h1')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((t) => t.length > 0);
  const canonical = $('link[rel="canonical"]').first().attr('href')?.trim() || null;

  const robotsContent = (
    $('meta[name="robots"]').first().attr('content') ?? ''
  ).toLowerCase();
  const robotsNoindex = robotsContent.split(/[\s,]+/).includes('noindex');

  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch {
    origin = '';
  }

  const images: CrawledImage[] = $('img')
    .map((_, el) => ({
      src: $(el).attr('src') ?? '',
      alt: $(el).attr('alt') ?? '',
    }))
    .get();

  const links: CrawledLink[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    let absolute: string;
    let linkOrigin = '';
    try {
      const u = new URL(href, url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return; // mailto:, tel:, javascript:
      u.hash = '';
      absolute = u.href;
      linkOrigin = u.origin;
    } catch {
      return; // unresolvable href — skip
    }
    links.push({
      href,
      absolute,
      internal: origin !== '' && linkOrigin === origin,
      text: $(el).text().trim().replace(/\s+/g, ' ').slice(0, 120),
    });
  });

  // JSON-LD schema detection (scan before stripping scripts)
  const schemaTypes = new Set<string>();
  let faqFallback = false;
  let articleFallback = false;
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).text();
    try {
      collectJsonLdTypes(JSON.parse(txt), schemaTypes);
    } catch {
      if (txt.includes('"@type":"FAQPage"') || txt.includes('"@type": "FAQPage"'))
        faqFallback = true;
      if (txt.includes('"@type":"Article"') || txt.includes('"@type": "Article"'))
        articleFallback = true;
    }
  });
  const hasFaqSchema = schemaTypes.has('FAQPage') || faqFallback;
  const hasArticleSchema = schemaTypes.has('Article') || articleFallback;

  const viewport = $('meta[name="viewport"]').first().attr('content')?.trim() || null;
  const hasOgTags =
    !!$('meta[property="og:title"]').first().attr('content')?.trim() ||
    !!$('meta[property="og:description"]').first().attr('content')?.trim();

  // word count from visible body text
  $('script, style, noscript').remove();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(' ').length : 0;

  return {
    url,
    statusCode: 200,
    title,
    titleLen: title.length,
    metaDescription,
    metaDescLen: metaDescription ? metaDescription.length : 0,
    h1s,
    h1Count: h1s.length,
    canonical,
    robotsNoindex,
    images,
    links,
    wordCount,
    hasFaqSchema,
    hasArticleSchema,
    viewport,
    hasOgTags,
    loadMs: 0,
  };
}

function minimalPage(url: string, statusCode: number, loadMs: number): AnalyzedPage {
  return {
    url,
    statusCode,
    title: '',
    titleLen: 0,
    metaDescription: null,
    metaDescLen: 0,
    h1s: [],
    h1Count: 0,
    canonical: null,
    robotsNoindex: false,
    images: [],
    links: [],
    wordCount: 0,
    hasFaqSchema: false,
    hasArticleSchema: false,
    viewport: null,
    hasOgTags: false,
    loadMs,
  };
}

// ---------- network helpers ----------

async function fetchWithTimeout(url: string, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  // SSRF-protected: validates host + every redirect hop before fetching.
  return safeFetch(url, { headers: { 'User-Agent': CRAWLER_UA, Accept: 'text/html,application/xhtml+xml' } }, ms);
}

function normalizeUrl(u: string): string | null {
  try {
    const url = new URL(u);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

async function fetchRobotsDisallows(origin: string): Promise<{ found: boolean; disallows: string[] }> {
  try {
    const res = await fetchWithTimeout(`${origin}/robots.txt`);
    if (!res.ok) return { found: false, disallows: [] };
    const text = await res.text();
    const disallows: string[] = [];
    let appliesToAll = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.split('#')[0].trim();
      if (!line) continue;
      const ua = line.match(/^user-agent\s*:\s*(.+)$/i);
      if (ua) {
        appliesToAll = ua[1].trim() === '*';
        continue;
      }
      const d = line.match(/^disallow\s*:\s*(.*)$/i);
      if (d && appliesToAll) {
        const p = d[1].trim();
        if (p) disallows.push(p);
      }
    }
    return { found: true, disallows };
  } catch {
    // missing/unreachable robots.txt => allow all
    return { found: false, disallows: [] };
  }
}

async function checkSitemap(origin: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${origin}/sitemap.xml`);
    return res.status === 200;
  } catch {
    return false;
  }
}

function isAllowedPath(pathname: string, disallows: string[]): boolean {
  return !disallows.some((d) => pathname.startsWith(d));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** BFS same-origin crawl. All per-page errors are caught; crawl continues. */
export async function crawlSite(startUrl: string, opts: CrawlOpts): Promise<CrawlResult> {
  const start = normalizeUrl(startUrl);
  if (!start) throw new Error(`Invalid start URL: ${startUrl}`);
  const origin = new URL(start).origin;

  const { found: robotsFound, disallows } = await fetchRobotsDisallows(origin);
  const sitemapFound = await checkSitemap(origin);

  const visited = new Set<string>();
  const statusByUrl = new Map<string, number>();
  const pages: AnalyzedPage[] = [];
  const queue: string[] = [start];

  let done = 0;
  let inFlight = 0;

  async function processUrl(raw: string): Promise<void> {
    const t0 = Date.now();
    try {
      const u = new URL(raw);
      if (u.origin !== origin) return;
      if (!isAllowedPath(u.pathname, disallows)) return;

      let res: Response | null = null;
      try {
        res = await fetchWithTimeout(raw);
      } catch {
        res = null; // network error / timeout
      }
      const loadMs = Date.now() - t0;
      if (!res) {
        pages.push(minimalPage(raw, 0, loadMs));
        statusByUrl.set(raw, 0);
        return;
      }
      const finalUrl = normalizeUrl(res.url) ?? raw;
      // do not follow redirects off-origin
      try {
        if (new URL(finalUrl).origin !== origin) {
          pages.push(minimalPage(raw, res.status, loadMs));
          statusByUrl.set(raw, res.status);
          return;
        }
      } catch {
        pages.push(minimalPage(raw, res.status, loadMs));
        statusByUrl.set(raw, res.status);
        return;
      }
      visited.add(finalUrl);
      statusByUrl.set(raw, res.status);
      statusByUrl.set(finalUrl, res.status);

      const contentType = res.headers.get('content-type') ?? '';
      if (res.status === 200 && contentType.includes('text/html')) {
        try {
          const html = await res.text();
          const page = analyzePage(html, finalUrl);
          page.loadMs = loadMs;
          pages.push(page);
          for (const l of page.links) {
            if (!l.internal) continue;
            const target = normalizeUrl(l.absolute);
            if (
              target &&
              !visited.has(target) &&
              !queue.includes(target) &&
              visited.size + queue.length < opts.maxPages
            ) {
              queue.push(target);
            }
          }
        } catch {
          pages.push(minimalPage(finalUrl, res.status, loadMs));
        }
      } else {
        // skip non-200 / non-HTML for parsing, but record
        pages.push(minimalPage(finalUrl, res.status, loadMs));
      }
    } finally {
      inFlight -= 1;
      done += 1;
      opts.onPage?.(done);
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (done >= opts.maxPages) return;
      const raw = queue.shift();
      if (!raw) {
        if (inFlight === 0) return;
        await sleep(50);
        continue;
      }
      if (visited.has(raw)) continue;
      visited.add(raw);
      inFlight += 1;
      await processUrl(raw);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(CONCURRENCY, opts.maxPages)) },
    () => worker(),
  );
  await Promise.all(workers);

  // ---- broken-link verification: every unique internal target not crawled with 200
  const targets = new Map<string, string>(); // target -> first linking page
  for (const p of pages) {
    for (const l of p.links) {
      if (!l.internal) continue;
      const t = normalizeUrl(l.absolute);
      if (t && !targets.has(t)) targets.set(t, p.url);
    }
  }
  const brokenLinks: BrokenLink[] = [];
  const verifyCap = opts.maxPages * 2;
  let verifications = 0;
  for (const [target, from] of targets) {
    const known = statusByUrl.get(target);
    if (known !== undefined) {
      if (known >= 400 || known === 0) brokenLinks.push({ from, to: target, status: known });
      continue;
    }
    if (verifications >= verifyCap) continue;
    verifications += 1;
    try {
      const res = await fetchWithTimeout(target);
      statusByUrl.set(target, res.status);
      if (res.status >= 400) brokenLinks.push({ from, to: target, status: res.status });
    } catch {
      brokenLinks.push({ from, to: target, status: 0 });
    }
  }

  return { pages, brokenLinks, robotsFound, sitemapFound };
}
