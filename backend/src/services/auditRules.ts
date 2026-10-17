// Audit rules for the SEO crawler (P2).
// Rules are data: { type, severity, check(page, ctx) }.
// Plain-language details + fix suggestions for non-expert site owners.

import type { AnalyzedPage, BrokenLink } from './crawler.js';

export type Severity = 'info' | 'warning' | 'error';

export interface IssueDraft {
  type: string;
  severity: Severity;
  url: string;
  detail: string;
  fix_suggestion: string;
}

export interface RuleCtx {
  /** normalized title -> number of pages using it */
  titleCounts: Map<string, number>;
  /** normalized meta description -> number of pages using it */
  metaDescCounts: Map<string, number>;
  robotsFound: boolean;
  sitemapFound: boolean;
  /** real Core Web Vitals for the homepage (null when PageSpeed unavailable) */
  pagespeed?: { lcpMs: number | null; cls: number | null; performanceScore: number | null } | null;
  /** internal: site-level rules already emitted (init by runRules) */
  siteEmitted?: Set<string>;
  // ---- C-04 additions ----
  /** sitemap URLs with no incoming internal links (orphan pages) */
  orphans?: string[];
  /** near-duplicate page clusters (each a list of urls) */
  dupClusters?: string[][];
  /** normalized url -> inbound internal link count */
  inlinks?: Map<string, number>;
  /** homepage url (for impact weighting context) */
  homepageUrl?: string;
  /** redirect chains detected during the crawl */
  redirectChains?: Array<{ from: string; to: string; hops: number | null; loopSuspected: boolean }>;
}

export interface Rule {
  type: string;
  severity: Severity;
  /** site-level rules run once per site instead of per page */
  siteLevel?: boolean;
  check(page: AnalyzedPage, ctx: RuleCtx): IssueDraft[];
}

function mk(
  type: string,
  severity: Severity,
  url: string,
  detail: string,
  fix_suggestion: string,
): IssueDraft {
  return { type, severity, url, detail, fix_suggestion };
}

/** Emit a site-level rule at most once per run, on the page it first runs against. */
function oncePerSite(ctx: RuleCtx, key: string): boolean {
  ctx.siteEmitted ??= new Set<string>();
  if (ctx.siteEmitted.has(key)) return false;
  ctx.siteEmitted.add(key);
  return true;
}

export const RULES: Rule[] = [
  {
    type: 'missing-title',
    severity: 'error',
    check: (p) =>
      p.title
        ? []
        : [
            mk(
              'missing-title',
              'error',
              p.url,
              'This page has no <title> tag, so search results show a meaningless snippet.',
              'Add a unique, descriptive <title> of 30–60 characters with the page\u2019s main keyword near the start.',
            ),
          ],
  },
  {
    type: 'title-long',
    severity: 'warning',
    check: (p) =>
      p.titleLen > 60
        ? [
            mk(
              'title-long',
              'warning',
              p.url,
              `Title is ${p.titleLen} characters long \u2014 Google cuts titles off after about 60 characters.`,
              'Shorten the title to under 60 characters and put the most important keyword first.',
            ),
          ]
        : [],
  },
  {
    type: 'title-short',
    severity: 'info',
    check: (p) =>
      p.titleLen > 0 && p.titleLen < 30
        ? [
            mk(
              'title-short',
              'info',
              p.url,
              `Title is only ${p.titleLen} characters \u2014 very short titles waste ranking opportunity.`,
              'Expand the title toward 30\u201360 characters with a keyword and a benefit or location.',
            ),
          ]
        : [],
  },
  {
    type: 'missing-meta-description',
    severity: 'warning',
    check: (p) =>
      p.metaDescription
        ? []
        : [
            mk(
              'missing-meta-description',
              'warning',
              p.url,
              'No meta description set \u2014 Google will pick a random snippet for this page.',
              'Write a 120\u2013160 character summary that sells the click and includes the main keyword.',
            ),
          ],
  },
  {
    type: 'meta-description-long',
    severity: 'info',
    check: (p) =>
      p.metaDescLen > 160
        ? [
            mk(
              'meta-description-long',
              'info',
              p.url,
              `Meta description is ${p.metaDescLen} characters \u2014 Google truncates after about 160.`,
              'Trim it to 120\u2013160 characters, keeping the call to action near the front.',
            ),
          ]
        : [],
  },
  {
    type: 'duplicate-title',
    severity: 'warning',
    check: (p, ctx) => {
      const t = p.title.trim().toLowerCase();
      const count = t ? ctx.titleCounts.get(t) ?? 0 : 0;
      return count > 1
        ? [
            mk(
              'duplicate-title',
              'warning',
              p.url,
              `The title "${p.title}" is used on ${count} pages \u2014 search engines can\u2019t tell them apart.`,
              'Give every page a unique title that reflects its specific topic or keyword.',
            ),
          ]
        : [];
    },
  },
  {
    type: 'missing-h1',
    severity: 'warning',
    check: (p) =>
      p.h1Count === 0
        ? [
            mk(
              'missing-h1',
              'warning',
              p.url,
              'No <h1> heading found \u2014 search engines use it to understand the page topic.',
              'Add exactly one <h1> that matches the page\u2019s main keyword or title.',
            ),
          ]
        : [],
  },
  {
    type: 'multiple-h1',
    severity: 'info',
    check: (p) =>
      p.h1Count > 1
        ? [
            mk(
              'multiple-h1',
              'info',
              p.url,
              `Page has ${p.h1Count} <h1> tags \u2014 the main topic signal gets diluted.`,
              'Keep one <h1> per page; demote the rest to <h2>.',
            ),
          ]
        : [],
  },
  {
    type: 'images-missing-alt',
    severity: 'warning',
    check: (p) => {
      const missing = p.images.filter((i) => !i.alt || !i.alt.trim()).length;
      return missing > 0
        ? [
            mk(
              'images-missing-alt',
              'warning',
              p.url,
              `${missing} of ${p.images.length} images are missing alt text \u2014 they can\u2019t rank in image search and hurt accessibility.`,
              'Add short, descriptive alt text to every image (decorative images can use an empty alt).',
            ),
          ]
        : [];
    },
  },
  {
    type: 'missing-canonical',
    severity: 'info',
    check: (p) =>
      p.canonical
        ? []
        : [
            mk(
              'missing-canonical',
              'info',
              p.url,
              'No canonical tag \u2014 duplicate-content versions of this URL may split ranking signals.',
              'Add <link rel="canonical"> pointing to the preferred URL of this page.',
            ),
          ],
  },
  {
    type: 'page-noindex',
    severity: 'warning',
    check: (p) =>
      p.robotsNoindex
        ? [
            mk(
              'page-noindex',
              'warning',
              p.url,
              'This page has a "noindex" robots tag \u2014 search engines are told NOT to index it.',
              'Remove the noindex tag if this page should appear in search results; keep it only if intentional.',
            ),
          ]
        : [],
  },
  {
    type: 'no-faq-schema',
    severity: 'info',
    check: (p) =>
      p.hasFaqSchema
        ? []
        : [
            mk(
              'no-faq-schema',
              'info',
              p.url,
              'No FAQ structured data found on this page.',
              'Add FAQ schema to be eligible for AI answers and rich results in Google and AI search.',
            ),
          ],
  },
  {
    type: 'thin-content',
    severity: 'info',
    check: (p) =>
      p.wordCount < 200
        ? [
            mk(
              'thin-content',
              'info',
              p.url,
              `Page has only ${p.wordCount} words of text \u2014 thin pages rarely rank.`,
              'Expand the page with genuinely useful content: answer related questions, add examples and an FAQ.',
            ),
          ]
        : [],
  },
  {
    type: 'duplicate-meta-description',
    severity: 'warning',
    check: (p, ctx) => {
      const d = (p.metaDescription ?? '').trim().toLowerCase();
      const count = d ? ctx.metaDescCounts.get(d) ?? 0 : 0;
      return count > 1
        ? [
            mk(
              'duplicate-meta-description',
              'warning',
              p.url,
              `The same meta description is used on ${count} pages \u2014 search results for those pages look identical.`,
              'Write a unique meta description per page that reflects its specific topic.',
            ),
          ]
        : [];
    },
  },
  {
    type: 'slow-page',
    severity: 'warning',
    check: (p) =>
      p.loadMs > 3000
        ? [
            mk(
              'slow-page',
              'warning',
              p.url,
              `This page took ${(p.loadMs / 1000).toFixed(1)}s to load \u2014 slow pages rank worse and lose visitors.`,
              'Compress images, enable caching, and remove heavy scripts to get load time under 2 seconds.',
            ),
          ]
        : [],
  },
  {
    type: 'missing-viewport',
    severity: 'warning',
    check: (p) =>
      p.viewport
        ? []
        : [
            mk(
              'missing-viewport',
              'warning',
              p.url,
              'No mobile viewport tag \u2014 the page will not display correctly on phones, and most of your visitors are on mobile.',
              'Add <meta name="viewport" content="width=device-width, initial-scale=1"> inside the page <head>.',
            ),
          ],
  },
  {
    type: 'missing-og-tags',
    severity: 'info',
    check: (p) =>
      p.hasOgTags
        ? []
        : [
            mk(
              'missing-og-tags',
              'info',
              p.url,
              'No Open Graph tags \u2014 when this page is shared on social media or messaging apps it shows a plain, unattractive preview.',
              'Add og:title and og:description meta tags so shared links look professional.',
            ),
          ],
  },
  {
    type: 'poor-lcp',
    severity: 'error',
    siteLevel: true,
    check: (p, ctx) => {
      const lcp = ctx.pagespeed?.lcpMs;
      if (lcp == null || !oncePerSite(ctx, 'poor-lcp')) return [];
      if (lcp <= 2500) return [];
      const sev: Severity = lcp > 4000 ? 'error' : 'warning';
      return [
        mk(
          'poor-lcp',
          sev,
          p.url,
          `Largest Contentful Paint is ${(lcp / 1000).toFixed(1)}s on mobile (Google wants under 2.5s) \u2014 slow pages rank worse.`,
          'Compress hero images (WebP), preload the LCP image, and remove render-blocking scripts.',
        ),
      ];
    },
  },
  {
    type: 'poor-cls',
    severity: 'warning',
    siteLevel: true,
    check: (p, ctx) => {
      const cls = ctx.pagespeed?.cls;
      if (cls == null || !oncePerSite(ctx, 'poor-cls')) return [];
      if (cls <= 0.1) return [];
      return [
        mk(
          'poor-cls',
          cls > 0.25 ? 'warning' : 'info',
          p.url,
          `Cumulative Layout Shift is ${cls.toFixed(2)} (Google wants under 0.10) \u2014 page elements jump around while loading.`,
          'Set explicit width/height on images and ads so content does not shift as it loads.',
        ),
      ];
    },
  },
  {
    type: 'missing-robots',
    severity: 'info',
    siteLevel: true,
    check: (p, ctx) =>
      !ctx.robotsFound && oncePerSite(ctx, 'missing-robots')
        ? [
            mk(
              'missing-robots',
              'info',
              p.url,
              'No robots.txt found at the site root.',
              'Add a robots.txt file so you control how crawlers treat your site (and can confirm nothing important is blocked).',
            ),
          ]
        : [],
  },
  {
    type: 'missing-sitemap',
    severity: 'info',
    siteLevel: true,
    check: (p, ctx) =>
      !ctx.sitemapFound && oncePerSite(ctx, 'missing-sitemap')
        ? [
            mk(
              'missing-sitemap',
              'info',
              p.url,
              'No sitemap.xml found at the site root \u2014 new pages get discovered slower.',
              'Generate a sitemap.xml listing all important URLs and submit it in Google Search Console.',
            ),
          ]
        : [],
  },
  // ---------------- C-04 rules ----------------
  {
    type: 'redirect-chain-long',
    severity: 'warning',
    check: (p) => {
      const hops = p.redirectHops ?? 0;
      return hops > 3
        ? [
            mk(
              'redirect-chain-long',
              'warning',
              p.url,
              `This page redirects through ${hops} hops before loading \u2014 every hop slows the page and leaks ranking signal.`,
              'Point links and the sitemap directly at the final URL so the redirect chain is at most 1 hop.',
            ),
          ]
        : [];
    },
  },
  {
    type: 'redirect-loop',
    severity: 'error',
    check: (p, ctx) => {
      const chains = ctx.redirectChains ?? [];
      const loop = chains.find((c) => c.loopSuspected && (c.from === p.url || c.to === p.url));
      return loop
        ? [
            mk(
              'redirect-loop',
              'error',
              p.url,
              'This URL is caught in a redirect loop \u2014 browsers show an error and search engines drop the page.',
              'Fix the redirect rules on your server/hosting so the URL resolves to one final page.',
            ),
          ]
        : [];
    },
  },
  {
    type: 'orphan-page',
    severity: 'info',
    check: (p, ctx) => {
      const orphans = ctx.orphans ?? [];
      return orphans.includes(p.url)
        ? [
            mk(
              'orphan-page',
              'info',
              p.url,
              'This page is in your sitemap but no other page on your site links to it \u2014 visitors and crawlers can hardly find it.',
              'Add internal links to this page from relevant pages (navigation, related posts, category pages).',
            ),
          ]
        : [];
    },
  },
  {
    type: 'duplicate-content',
    severity: 'warning',
    check: (p, ctx) => {
      const clusters = ctx.dupClusters ?? [];
      const cluster = clusters.find((c) => c.includes(p.url));
      if (!cluster) return [];
      const others = cluster.filter((u) => u !== p.url).slice(0, 3);
      return [
        mk(
          'duplicate-content',
          'warning',
          p.url,
          `This page's content is nearly identical to ${cluster.length - 1} other page(s)${others.length ? ` (e.g. ${others.join(', ')})` : ''} \u2014 search engines may rank the wrong one or none.`,
          'Differentiate the pages with unique content, or canonicalize/merge the duplicates into one page.',
        ),
      ];
    },
  },
  {
    type: 'image-too-large',
    severity: 'warning',
    check: (p) => {
      const big = p.images.filter((i) => (i.bytes ?? 0) > 1_000_000);
      return big.length > 0
        ? [
            mk(
              'image-too-large',
              'warning',
              p.url,
              `${big.length} image(s) are larger than 1 MB${big[0]?.src ? ` (e.g. ${big[0].src.slice(0, 80)})` : ''} \u2014 heavy images are the #1 cause of slow pages.`,
              'Compress images (WebP/AVIF) and resize them to the display size; aim for under 200 KB each.',
            ),
          ]
        : [];
    },
  },
  {
    type: 'image-missing-dimensions',
    severity: 'info',
    check: (p) => {
      const missing = p.images.filter((i) => !i.width || !i.height).length;
      return missing > 0
        ? [
            mk(
              'image-missing-dimensions',
              'info',
              p.url,
              `${missing} image(s) have no width/height attributes \u2014 the page layout shifts while images load (bad CLS score).`,
              'Add explicit width and height attributes to every <img> tag.',
            ),
          ]
        : [];
    },
  },
  {
    type: 'schema-invalid-json',
    severity: 'warning',
    check: (p) =>
      (p.schemaIssues ?? [])
        .filter((s) => s.type === 'schema-invalid-json')
        .map((s) => mk('schema-invalid-json', 'warning', p.url, s.message, s.fix)),
  },
  {
    type: 'schema-missing-field',
    severity: 'info',
    check: (p) =>
      (p.schemaIssues ?? [])
        .filter((s) => s.type === 'schema-missing-field')
        .slice(0, 5)
        .map((s) => mk('schema-missing-field', 'info', p.url, s.message, s.fix)),
  },
];

/** Run all rules over crawled pages + verified broken links. */
export function runRules(
  pages: AnalyzedPage[],
  brokenLinks: BrokenLink[],
  ctx: RuleCtx,
): IssueDraft[] {
  ctx.siteEmitted ??= new Set<string>();
  const issues: IssueDraft[] = [];
  // Content rules only apply to successfully fetched HTML pages.
  const contentPages = pages.filter((p) => p.statusCode === 200);
  const pageRules = RULES.filter((r) => !r.siteLevel);
  for (const page of contentPages) {
    for (const rule of pageRules) issues.push(...rule.check(page, ctx));
  }
  // Site-level rules run once, against the first page as context for the URL.
  const siteAnchor: AnalyzedPage =
    pages[0] ??
    ({
      url: '',
      statusCode: 0,
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
      loadMs: 0,
    } satisfies AnalyzedPage);
  for (const rule of RULES.filter((r) => r.siteLevel)) {
    issues.push(...rule.check(siteAnchor, ctx));
  }
  for (const b of brokenLinks) {
    // Timeouts (status 0) are warnings, not errors — the link might work,
    // the check just couldn't complete. Don't scare users with false errors.
    const isTimeout = b.status === 0;
    issues.push(
      mk(
        'broken-link',
        isTimeout ? 'warning' : 'error',
        b.from,
        isTimeout
          ? `Link to ${b.to} couldn't be checked (timeout). It may work — verify manually.`
          : `Link to ${b.to} returned HTTP ${b.status}.`,
        isTimeout
          ? 'Open the link in your browser to verify it works.'
          : 'Fix the link target, point it at a working URL, or remove the link.',
      ),
    );
  }
  return issues;
}

const SEVERITY_WEIGHTS: Record<Severity, number> = { error: 10, warning: 4, info: 1 };

/** Health score: 100 - min(90, weighted deductions), floored at 0. */
export function scoreFor(issues: { severity: string; type: string }[]): number {
  // Dedupe by issue type — 100 duplicate-content warnings on different pages
  // should not tank the score 100x. Each unique problem counts once.
  const seen = new Set<string>();
  let deduction = 0;
  for (const i of issues) {
    const key = `${i.severity}:${i.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduction += SEVERITY_WEIGHTS[i.severity as Severity] ?? 0;
  }
  return Math.max(0, 100 - Math.min(90, deduction));
}
