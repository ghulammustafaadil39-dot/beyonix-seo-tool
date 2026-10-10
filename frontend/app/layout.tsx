import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Beyonix SEO — SEO + GEO toolkit for small businesses',
  description:
    'Site audits, keyword research, rank tracking, AI content, and AI-search (GEO) visibility — one simple dashboard.',
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
      <body className="bg-[#04090c] text-white antialiased">{children}</body>
    </html>
  );
}
