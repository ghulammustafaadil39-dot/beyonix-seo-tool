import type { MetadataRoute } from 'next';

/** F-12 — robots.txt: index the marketing site, keep the app private. */
export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_SITE_URL || 'https://app.beyonixseo.com';
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/dashboard', '/admin', '/api'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
