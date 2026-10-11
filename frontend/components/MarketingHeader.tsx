'use client';

import Link from 'next/link';

const NAV = [
  { href: '/#features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/docs', label: 'Docs' },
  { href: '/#faq', label: 'FAQ' },
];

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className={`flex items-center gap-2.5 ${compact ? '' : ''}`} aria-label="Beyonix SEO home">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-300 to-teal-400 text-lg font-bold text-[#04181a] shadow-[0_0_24px_rgba(45,212,191,0.45)]">
        B
      </span>
      <span className="text-lg font-bold tracking-tight text-white">
        Beyonix <span className="text-teal-300">SEO</span>
      </span>
    </Link>
  );
}

export default function MarketingHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-[#04090c]/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <Logo />
        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="rounded-md px-3 py-2 text-sm font-medium text-white/60 transition hover:bg-white/5 hover:text-white"
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="hidden text-sm font-medium text-white/60 transition hover:text-white sm:inline"
          >
            Log in
          </Link>
          <Link href="/signup" className="bx-btn-primary">
            Start free
          </Link>
        </div>
      </div>
    </header>
  );
}
