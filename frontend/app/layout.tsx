import type { Metadata, Viewport } from 'next';
import './globals.css';
import CookieBanner from '@/components/CookieBanner';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://app.beyonixseo.com';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Beyonix SEO — SEO + GEO toolkit for small businesses',
    template: '%s — Beyonix SEO',
  },
  description:
    'Site audits, keyword research, rank tracking, AI content, and AI-search (GEO) visibility — one simple dashboard.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'Beyonix SEO',
    title: 'Beyonix SEO — SEO + GEO toolkit for small businesses',
    description:
      'Site audits, keyword research, rank tracking, AI content, and AI-search (GEO) visibility — one simple dashboard.',
    url: '/',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Beyonix SEO — SEO + GEO toolkit for small businesses',
    description:
      'Site audits, keyword research, rank tracking, AI content, and AI-search (GEO) visibility — one simple dashboard.',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#04090c',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-[#04090c] text-white antialiased">
        {children}
        <CookieBanner />
      </body>
    </html>
  );
}
