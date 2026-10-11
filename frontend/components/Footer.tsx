import Link from 'next/link';
import { Logo } from './MarketingHeader';

const COLS: Array<{ title: string; links: Array<{ href: string; label: string }> }> = [
  {
    title: 'Product',
    links: [
      { href: '/#features', label: 'Features' },
      { href: '/pricing', label: 'Pricing' },
      { href: '/docs', label: 'Documentation' },
      { href: '/docs/api', label: 'API docs' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { href: '/docs/getting-started', label: 'Getting started' },
      { href: '/docs/methodology', label: 'How scores are computed' },
      { href: '/docs/glossary', label: 'SEO glossary' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { href: '/legal/terms', label: 'Terms of service' },
      { href: '/legal/privacy', label: 'Privacy policy' },
      { href: '/legal/dpa', label: 'Data processing agreement' },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="border-t border-white/10 py-12">
      <div className="mx-auto max-w-6xl px-4">
        <div className="grid gap-8 md:grid-cols-[1.5fr_repeat(3,1fr)]">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-sm text-white/50">
              SEO + GEO visibility for small businesses — audits, keywords, rank
              tracking, AI content, and AI-search visibility in one dashboard.
            </p>
            <p className="mt-4 font-mono text-xs text-white/30">
              $ ./beyonix-seo --up <span className="text-teal-300/70">▊</span>
            </p>
          </div>
          {COLS.map((c) => (
            <nav key={c.title} aria-label={c.title}>
              <p className="bx-micro mb-3">{c.title}</p>
              <ul className="space-y-2">
                {c.links.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      className="text-sm text-white/60 transition hover:text-white"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="mt-10 flex flex-col gap-2 border-t border-white/5 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-xs text-white/30">
            © 2026 Beyonix Solutions — Beyonix SEO
          </p>
          <p className="font-mono text-xs text-white/30">
            Status: <span className="text-teal-300">all systems operational</span>
          </p>
        </div>
      </div>
    </footer>
  );
}
