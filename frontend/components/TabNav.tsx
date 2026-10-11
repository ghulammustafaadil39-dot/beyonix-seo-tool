'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const SITE_TABS = [
  { slug: 'audit', label: 'Audit' },
  { slug: 'keywords', label: 'Keywords' },
  { slug: 'rankings', label: 'Rankings' },
  { slug: 'content', label: 'Content' },
  { slug: 'onpage', label: 'On-page' },
  { slug: 'backlinks', label: 'Backlinks' },
  { slug: 'geo', label: 'GEO' },
  { slug: 'competitors', label: 'Competitors' },
  { slug: 'reports', label: 'Reports' },
];

export default function TabNav({ siteId }: { siteId: string }) {
  const pathname = usePathname();
  const linkCls = (active: boolean) =>
    `rounded-md px-3.5 py-2 text-sm font-medium transition ${
      active
        ? 'bg-teal-400/15 text-teal-200 shadow-[inset_0_0_0_1px_rgba(45,212,191,0.25)]'
        : 'text-white/50 hover:bg-white/5 hover:text-white'
    }`;
  return (
    <nav className="mb-6 inline-flex max-w-full flex-wrap gap-1 overflow-x-auto rounded-xl border border-white/10 bg-[#06141d] p-1.5">
      <Link
        href={`/dashboard/sites/${siteId}`}
        className={linkCls(pathname === `/dashboard/sites/${siteId}`)}
      >
        Overview
      </Link>
      {SITE_TABS.map((t) => {
        const href = `/dashboard/sites/${siteId}/${t.slug}`;
        return (
          <Link key={t.slug} href={href} className={linkCls(pathname === href)}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
