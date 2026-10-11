import type { MetadataRoute } from 'next';

/**
 * F-12 — the product practices SEO: sitemap for the public pages.
 * App/dashboard routes are deliberately excluded (authenticated, noindex).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXT_PUBLIC_SITE_URL || 'https://app.beyonixseo.com';
  const now = new Date();
  const docs: MetadataRoute.Sitemap = [
    'getting-started',
    'connecting-google',
    'methodology',
    'keyword-research',
    'geo-guide',
    'glossary',
  ].map((slug) => ({
    url: `${base}/docs/${slug}`,
    lastModified: now,
    changeFrequency: 'monthly',
    priority: 0.6,
  }));
  return [
    { url: base, lastModified: now, changeFrequency: 'weekly', priority: 1 },
    { url: `${base}/pricing`, lastModified: now, changeFrequency: 'weekly', priority: 0.9 },
    { url: `${base}/docs`, lastModified: now, changeFrequency: 'weekly', priority: 0.8 },
    ...docs,
    { url: `${base}/legal/terms`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${base}/legal/privacy`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${base}/legal/dpa`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
