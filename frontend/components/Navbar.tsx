'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { adminApi, authApi, ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

const LINKS: Array<{ href: string; labelKey: 'nav.sites' | 'nav.team' | 'nav.apiKeys' | 'nav.notifications' | 'nav.billing' | 'nav.settings' }> = [
  { href: '/dashboard', labelKey: 'nav.sites' },
  { href: '/dashboard/team', labelKey: 'nav.team' },
  { href: '/dashboard/api-keys', labelKey: 'nav.apiKeys' },
  { href: '/dashboard/notifications', labelKey: 'nav.notifications' },
  { href: '/dashboard/billing', labelKey: 'nav.billing' },
  { href: '/dashboard/settings', labelKey: 'nav.settings' },
];

export default function Navbar() {
  const pathname = usePathname();
  const { t } = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    // Show the Admin link only to platform admins. /auth/me does not
    // expose any admin flag (by design), so probe the admin API itself:
    // it answers 404 for everyone else. The page re-checks on load.
    adminApi
      .tenants(1, 1)
      .then(() => setIsAdmin(true))
      .catch((e) => {
        if (!(e instanceof ApiError) || e.status !== 404) setIsAdmin(false);
      });
  }, []);

  const logout = async () => {
    try {
      await authApi.logout();
    } catch {
      // cookie may already be gone; still redirect
    }
    router.push('/login');
  };

  const isActive = (href: string) =>
    href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href);

  return (
    <header className="border-b border-white/10 bg-[#04090c]/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/dashboard" className="flex items-center gap-2.5" onClick={() => setOpen(false)}>
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-300 to-teal-400 text-lg font-bold text-[#04181a] shadow-[0_0_20px_rgba(45,212,191,0.4)]">
            B
          </span>
          <span className="text-lg font-bold tracking-tight text-white">
            Beyonix <span className="text-teal-300">SEO</span>
          </span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 sm:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-md px-3 py-2 text-sm font-medium transition ${
                isActive(l.href)
                  ? 'bg-teal-400/10 text-teal-300'
                  : 'text-white/60 hover:bg-white/5 hover:text-white'
              }`}
            >
              {t(l.labelKey)}
            </Link>
          ))}
          {isAdmin && (
            <Link
              href="/admin"
              className={`rounded-md px-3 py-2 text-sm font-medium transition ${
                pathname.startsWith('/admin')
                  ? 'bg-teal-400/10 text-teal-300'
                  : 'text-white/60 hover:bg-white/5 hover:text-white'
              }`}
            >
              Admin
            </Link>
          )}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('beyonix:open-palette'))}
            aria-label={t('chrome.commandPalette')}
            title={`${t('chrome.commandPalette')} (⌘K)`}
            className="ml-1 hidden items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 font-mono text-xs text-white/50 transition hover:bg-white/10 hover:text-white md:inline-flex"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
            </svg>
            <kbd className="rounded border border-white/10 bg-black/40 px-1 text-[10px] text-white/55">⌘K</kbd>
          </button>
          <button
            onClick={logout}
            className="bx-btn-secondary ml-2 !px-3 !py-2"
          >
            {t('nav.logOut')}
          </button>
        </nav>

        {/* Mobile hamburger */}
        <button
          className="rounded-md p-2 text-white/60 hover:bg-white/5 sm:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? t('nav.closeMenu') : t('nav.openMenu')}
          aria-expanded={open}
        >
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            {open ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            )}
          </svg>
        </button>
      </div>

      {open && (
        <nav className="border-t border-white/5 px-4 py-2 sm:hidden">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className={`block rounded-md px-3 py-2 text-sm font-medium ${
                isActive(l.href)
                  ? 'bg-teal-400/10 text-teal-300'
                  : 'text-white/60 hover:bg-white/5 hover:text-white'
              }`}
            >
              {t(l.labelKey)}
            </Link>
          ))}
          {isAdmin && (
            <Link
              href="/admin"
              onClick={() => setOpen(false)}
              className={`block rounded-md px-3 py-2 text-sm font-medium ${
                pathname.startsWith('/admin')
                  ? 'bg-teal-400/10 text-teal-300'
                  : 'text-white/60 hover:bg-white/5 hover:text-white'
              }`}
            >
              Admin
            </Link>
          )}
          <button
            onClick={logout}
            className="bx-btn-secondary mt-1 w-full !justify-start"
          >
            {t('nav.logOut')}
          </button>
        </nav>
      )}
    </header>
  );
}
