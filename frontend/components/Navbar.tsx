'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { adminApi, authApi, ApiError } from '@/lib/api';

const LINKS = [
  { href: '/dashboard', label: 'Sites' },
  { href: '/dashboard/team', label: 'Team' },
  { href: '/dashboard/api-keys', label: 'API keys' },
  { href: '/dashboard/notifications', label: 'Notifications' },
  { href: '/dashboard/billing', label: 'Billing' },
  { href: '/dashboard/settings', label: 'Settings' },
];

export default function Navbar() {
  const pathname = usePathname();
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
              {l.label}
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
            onClick={logout}
            className="bx-btn-secondary ml-2 !px-3 !py-2"
          >
            Log out
          </button>
        </nav>

        {/* Mobile hamburger */}
        <button
          className="rounded-md p-2 text-white/60 hover:bg-white/5 sm:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Close menu' : 'Open menu'}
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
              {l.label}
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
            Log out
          </button>
        </nav>
      )}
    </header>
  );
}
