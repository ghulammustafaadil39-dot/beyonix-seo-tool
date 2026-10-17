// Site crawler for the technical SEO audit (C-04 quality pass).
// - analyzePage: PURE html -> structured page data (no network), unit-testable.
// - crawlSite: same-origin BFS crawl with:
//   - proper robots.txt parsing (per-user-agent groups, RFC 9309 longest-match,
//     crawl-delay honored via per-host politeness),
//   - redirect-chain / loop analysis (probe-based; safeFetch keeps per-hop
//     SSRF re-validation, so intermediate hops are never exposed raw),
//   - canonical / hreflang / pagination parsing,
//   - sitemap.xml parsing (orphan-page detection downstream),
//   - simhash per page (duplicate-content detection downstream),
//   - image size/dimension checks (HEAD, capped),
//   - PageSpeed handled in pagespeed.ts (cache + quotas),
//   - crawl resume after failure (CrawlState in/out),
//   - incremental recrawl (If-None-Match / If-Modified-Since -> 304 reuse).
// All fetches go through safeFetch (S-02 SSRF caps stay in force).

import * as cheerio from 'cheerio';
import { safeFetch } from './safeFetch.js';
import { parseRobotsTxt, isAllowedUrl, crawlDelayFor, sitemapUrlsFromRobots } from './robotsParser.js';
import { HostPoliteness } from './politeness.js';
import { parseSitemapXml } from './sitemap.js';
import { simhash64 } from './simhash.js';
import { validateJsonLd, type SchemaValidationIssue } from './structuredData.js';

export interface CrawledImage {
  src: string;
  alt: string;
  width?: string | null;
  height?: string | null;
  /** bytes from HEAD Content-Length (null when unknown) */
  bytes?: number | null;
  contentType?: string | null;
}

export interface CrawledLink {
  href: string;
  absolute: string;
  internal: boolean;
  text: string;
}

export interface Hreflang {
  lang: string;
  href: string;
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
  // ---- C-04 additions (optional for backwards compat with old fixtures) ----
  hreflangs?: Hreflang[];
  relNext?: string | null;
  relPrev?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  simhash?: string;
  jsonLdBlocks?: string[];
  schemaTypes?: string[];
  schemaIssues?: SchemaValidationIssue[];
  /** number of redirect hops the fetch took (0 = direct) */
  redirectHops?: number;
  /** true when the server answered 304 (incremental recrawl: page unchanged) */
  notModified?: boolean;
}

export interface BrokenLink {
  from: string;
  to: string;
  status: number; // HTTP status, or 0 on network error
}

export interface RedirectChain {
  from: string;
  to: string;
  /** exact hop count when <= maxProbe; null when the chain never terminates */
  hops: number | null;
  loopSuspected: boolean;
}

export interface CrawlState {
  visited: string[];
  queue: string[];
  done: number;
}

export interface CrawlResult {
  pages: AnalyzedPage[];
  brokenLinks: BrokenLink[];
  robotsFound: boolean;
  sitemapFound: boolean;
  sitemapUrls: string[];
  redirectChains: RedirectChain[];
}

export interface CrawlOpts {
  maxPages: number;
  onPage?: (n: number) => void;
  /** resume a previously interrupted crawl */
  resumeState?: CrawlState;
  /** called every 10 pages (and at the end) so the job can persist state */
  onState?: (s: CrawlState) => void;
  /** incremental recrawl: url -> known validators */
  conditional?: Map<string, { etag?: string; lastModified?: string }>;
  /** skip sitemap fetching (tests) */
  skipSitemap?: boolean;
  /** max images to HEAD-check per crawl (default 40) */
  imageCheckCap?: number;
}

const FETCH_TIMEOUT_MS = 8000;
const CONCURRENCY = 4;
const CRAWLER_UA = 'BeyonixSEO-Bot/1.0 (+https://beyonixsolutions.com)';
const MAX_REDIRECT_PROBE = 10;
const IMAGE_BYTES_WARN = 1_000_000; // 1 MB

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
      width: $(el).attr('width') ?? null,
      height: $(el).attr('height') ?? null,
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

  // hreflang + pagination
  const hreflangs: Hreflang[] = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const lang = ($(el).attr('hreflang') ?? '').trim().toLowerCase();
    const href = ($(el).attr('href') ?? '').trim();
    if (lang && href) hreflangs.push({ lang, href });
  });
  const relNext = $('link[rel="next"]').first().attr('href')?.trim() || null;
  const relPrev = $('link[rel="prev"]').first().attr('href')?.trim() || null;

  // JSON-LD blocks: types (fast scan) + validation issues.
  const jsonLdBlocks: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    jsonLdBlocks.push($(el).text());
  });
  const schemaTypes = new Set<string>();
  let faqFallback = false;
  let articleFallback = false;
  for (const txt of jsonLdBlocks) {
    try {
      collectJsonLdTypes(JSON.parse(txt), schemaTypes);
    } catch {
      if (txt.includes('"@type":"FAQPage"') || txt.includes('"@type": "FAQPage"'))
        faqFallback = true;
      if (txt.includes('"@type":"Article"') || txt.includes('"@type": "Article"'))
        articleFallback = true;
    }
  }
  const hasFaqSchema = schemaTypes.has('FAQPage') || faqFallback;
  const hasArticleSchema = schemaTypes.has('Article') || articleFallback;
  const schemaValidation = validateJsonLd(jsonLdBlocks);

  const viewport = $('meta[name="viewport"]').first().attr('content')?.trim() || null;
  const hasOgTags =
    !!$('meta[property="og:title"]').first().attr('content')?.trim() ||
    !!$('meta[property="og:description"]').first().attr('content')?.trim();

  // word count from visible body text
  // Strip boilerplate (nav/header/footer/aside) BEFORE simhash — comparing
  // full body text causes false duplicate positives on sites with big menus.
  $('script, style, noscript').remove();
  const $content = $('body').clone();
  $content.find('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .mega-menu, .dropdown-menu').remove();
  // Prefer <main> or <article> if present (real content area)
  const $main = $content.find('main, article, [role="main"]').first();
  const bodyText = ($main.length ? $main : $content).text().replace(/\s+/g, ' ').trim();
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
    hreflangs,
    relNext,
    relPrev,
    etag: null,
    lastModified: null,
    simhash: simhash64(bodyText),
    jsonLdBlocks,
    schemaTypes: [...schemaTypes],
    schemaIssues: schemaValidation.issues,
    redirectHops: 0,
    notModified: false,
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
    hreflangs: [],
    relNext: null,
    relPrev: null,
    etag: null,
    lastModified: null,
    simhash: '',
    jsonLdBlocks: [],
    schemaTypes: [],
    schemaIssues: [],
    redirectHops: 0,
    notModified: false,
  };
}

// ---------- network helpers ----------

function fetchHeaders(
  url: string,
  conditional?: Map<string, { etag?: string; lastModified?: string }>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': CRAWLER_UA,
    Accept: 'text/html,application/xhtml+xml',
  };
  const cond = conditional?.get(url);
  if (cond?.etag) headers['If-None-Match'] = cond.etag;
  if (cond?.lastModified) headers['If-Modified-Since'] = cond.lastModified;
  return headers;
}

async function fetchWithTimeout(
  url: string,
  ms = FETCH_TIMEOUT_MS,
  maxRedirects = 5,
  conditional?: Map<string, { etag?: string; lastModified?: string }>,
): Promise<Response> {
  // SSRF-protected: validates host + every redirect hop before fetching.
  return safeFetch(url, fetchHeaders(url, conditional), ms, maxRedirects);
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

/**
 * Redirect-chain / loop analysis. safeFetch never exposes intermediate hops
 * (each hop is re-validated for SSRF), so the chain length is probed: the
 * smallest maxRedirects that lets the fetch succeed IS the hop count. When
 * no probe up to MAX_REDIRECT_PROBE succeeds, the chain loops (or is absurdly
 * long) — reported as loopSuspected.
 */
export async function traceRedirectHops(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<RedirectChain> {
  for (let k = 1; k <= MAX_REDIRECT_PROBE; k++) {
    try {
      const res = await fetchWithTimeout(url, timeoutMs, k);
      const finalUrl = normalizeUrl(res.url) ?? url;
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      return { from: url, to: finalUrl, hops: k, loopSuspected: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/too many redirects/i.test(msg)) {
        // Non-redirect failure (timeout, SSRF block, size cap): not a chain.
        return { from: url, to: url, hops: null, loopSuspected: false };
      }
      // chain longer than k hops — probe deeper
    }
  }
  return { from: url, to: url, hops: null, loopSuspected: true };
}

interface RobotsInfo {
  found: boolean;
  text: string;
  sitemapUrls: string[];
}

async function fetchRobots(origin: string): Promise<RobotsInfo> {
  try {
    const res = await fetchWithTimeout(`${origin}/robots.txt`);
    if (!res.ok) return { found: false, text: '', sitemapUrls: [] };
    const text = await res.text();
    return { found: true, text, sitemapUrls: sitemapUrlsFromRobots(text) };
  } catch {
    // missing/unreachable robots.txt => allow all
    return { found: false, text: '', sitemapUrls: [] };
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

/** Fetch + parse sitemap(s): robots-declared URLs first, then /sitemap.xml. Caps nested fetches. */
async function collectSitemapUrls(robots: RobotsInfo, origin: string): Promise<string[]> {
  const out = new Set<string>();
  const queue = [...robots.sitemapUrls];
  if (queue.length === 0) queue.push(`${origin}/sitemap.xml`);
  let fetched = 0;
  while (queue.length > 0 && fetched < 10 && out.size < 5000) {
    const smUrl = queue.shift()!;
    fetched += 1;
    try {
      const res = await fetchWithTimeout(smUrl);
      if (!res.ok) continue;
      const xml = await res.text();
      const parsed = parseSitemapXml(xml);
      for (const u of parsed.urls) {
        if (out.size >= 5000) break;
        out.add(u.loc);
      }
      for (const nested of parsed.sitemaps.slice(0, 10)) queue.push(nested);
    } catch {
      /* unreachable sitemap — skip */
    }
  }
  return [...out];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** HEAD an image to learn its bytes + content type. Null fields on any failure. */
async function headImage(url: string): Promise<{ bytes: number | null; contentType: string | null }> {
  try {
    const res = await safeFetch(
      url,
      { method: 'HEAD', headers: { 'User-Agent': CRAWLER_UA } },
      5000,
    );
    const len = res.headers.get('content-length');
    const ct = res.headers.get('content-type');
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return { bytes: len ? parseInt(len, 10) || null : null, contentType: ct };
  } catch {
    return { bytes: null, contentType: null };
  }
}

/** BFS same-origin crawl. All per-page errors are caught; crawl continues. */
export async function crawlSite(startUrl: string, opts: CrawlOpts): Promise<CrawlResult> {
  const start = normalizeUrl(startUrl);
  if (!start) throw new Error(`Invalid start URL: ${startUrl}`);
  const origin = new URL(start).origin;
  const host = new URL(start).hostname;

  const robots = await fetchRobots(origin);
  const robotsFound = robots.found;
  const groups = parseRobotsTxt(robots.text);
  const crawlDelaySec = crawlDelayFor(groups, CRAWLER_UA);
  const politeness = new HostPoliteness(300);
  const crawlDelayMs = crawlDelaySec !== null ? Math.round(crawlDelaySec * 1000) : undefined;
  const isAllowed = (u: string): boolean => {
    try {
      return isAllowedUrl(groups, CRAWLER_UA, new URL(u).href);
    } catch {
      return false;
    }
  };

  const sitemapFound = await checkSitemap(origin);
  const sitemapUrls = opts.skipSitemap ? [] : await collectSitemapUrls(robots, origin);

  const visited = new Set<string>(opts.resumeState?.visited ?? []);
  const statusByUrl = new Map<string, number>();
  const pages: AnalyzedPage[] = [];
  const redirectChains: RedirectChain[] = [];
  const queue: string[] = opts.resumeState?.queue?.length ? [...opts.resumeState.queue] : [start];
  const imageCheckCap = opts.imageCheckCap ?? 40;
  let imagesChecked = 0;

  let done = opts.resumeState?.done ?? 0;
  let inFlight = 0;
  let pagesSinceState = 0;

  const emitState = (): void => {
    pagesSinceState += 1;
    if (opts.onState && (pagesSinceState >= 10 || done >= opts.maxPages)) {
      pagesSinceState = 0;
      opts.onState({ visited: [...visited], queue: [...queue], done });
    }
  };

  async function checkImages(page: AnalyzedPage): Promise<void> {
    const seen = new Set<string>();
    for (const img of page.images) {
      if (imagesChecked >= imageCheckCap) break;
      let abs: string;
      try {
        const u = new URL(img.src, page.url);
        if (u.origin !== origin) continue;
        u.hash = '';
        abs = u.href;
      } catch {
        continue;
      }
      if (seen.has(abs)) continue;
      seen.add(abs);
      imagesChecked += 1;
      await politeness.waitForHost(host, crawlDelayMs);
      const head = await headImage(abs);
      img.bytes = head.bytes;
      img.contentType = head.contentType;
    }
  }

  async function processUrl(raw: string): Promise<void> {
    const t0 = Date.now();
    try {
      const u = new URL(raw);
      if (u.origin !== origin) return;
      if (!isAllowed(raw)) return;

      await politeness.waitForHost(host, crawlDelayMs);

      let res: Response | null = null;
      try {
        res = await fetchWithTimeout(raw, FETCH_TIMEOUT_MS, 5, opts.conditional);
      } catch {
        res = null; // network error / timeout / SSRF block / size cap
      }
      const loadMs = Date.now() - t0;
      if (!res) {
        pages.push(minimalPage(raw, 0, loadMs));
        statusByUrl.set(raw, 0);
        return;
      }
      // Incremental recrawl: 304 => page unchanged, reuse previous record.
      if (res.status === 304) {
        const p = minimalPage(raw, 304, loadMs);
        p.notModified = true;
        pages.push(p);
        statusByUrl.set(raw, 304);
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
          page.statusCode = res.status;
          page.etag = res.headers.get('etag');
          page.lastModified = res.headers.get('last-modified');
          // Redirect-chain analysis when the fetch moved.
          if (finalUrl !== raw) {
            const chain = await traceRedirectHops(raw);
            chain.to = finalUrl;
            page.redirectHops = chain.hops ?? 0;
            redirectChains.push(chain);
          } else {
            page.redirectHops = 0;
          }
          await checkImages(page);
          pages.push(page);
          for (const l of page.links) {
            if (!l.internal) continue;
            const target = normalizeUrl(l.absolute);
            if (
              target &&
              !visited.has(target) &&
              !queue.includes(target) &&
              visited.size + queue.length < opts.maxPages &&
              isAllowed(target)
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
      emitState();
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
  opts.onState?.({ visited: [...visited], queue: [...queue], done });

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
      await politeness.waitForHost(host, crawlDelayMs);
      const res = await fetchWithTimeout(target);
      statusByUrl.set(target, res.status);
      if (res.status >= 400) brokenLinks.push({ from, to: target, status: res.status });
    } catch {
      brokenLinks.push({ from, to: target, status: 0 });
    }
  }

  return { pages, brokenLinks, robotsFound, sitemapFound, sitemapUrls, redirectChains };
}

export { IMAGE_BYTES_WARN };
