'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT, type MessageKey } from '@/lib/i18n';

// W-04: 'insights' tab added (renders an honest "not available yet" state
// until the backend GET /insights endpoint lands).
export const SITE_TABS: Array<{ slug: string; label: string; labelKey: MessageKey }> = [
  { slug: 'insights', label: 'Insights', labelKey: 'tabs.insights' },
  { slug: 'audit', label: 'Audit', labelKey: 'tabs.audit' },
  { slug: 'keywords', label: 'Keywords', labelKey: 'tabs.keywords' },
  { slug: 'rankings', label: 'Rankings', labelKey: 'tabs.rankings' },
  { slug: 'content', label: 'Content', labelKey: 'tabs.content' },
  { slug: 'onpage', label: 'On-page', labelKey: 'tabs.onpage' },
  { slug: 'backlinks', label: 'Backlinks', labelKey: 'tabs.backlinks' },
  { slug: 'geo', label: 'GEO', labelKey: 'tabs.geo' },
  { slug: 'competitors', label: 'Competitors', labelKey: 'tabs.competitors' },
  { slug: 'reports', label: 'Reports', labelKey: 'tabs.reports' },
];

export default function TabNav({ siteId }: { siteId: string }) {
  const pathname = usePathname();
  const { t } = useT();
  const linkCls = (active: boolean) =>
    `rounded-md px-3.5 py-2 text-sm font-medium transition ${
      active
        ? 'bg-teal-400/15 text-teal-200 shadow-[inset_0_0_0_1px_rgba(45,212,191,0.25)]'
        : 'text-white/50 hover:bg-white/5 hover:text-white'
    }`;
  return (
    <nav
      aria-label="Site sections"
      className="mb-6 inline-flex max-w-full flex-wrap gap-1 overflow-x-auto rounded-xl border border-white/10 bg-[#06141d] p-1.5"
    >
      <Link
        href={`/dashboard/sites/${siteId}`}
        className={linkCls(pathname === `/dashboard/sites/${siteId}`)}
        aria-current={pathname === `/dashboard/sites/${siteId}` ? 'page' : undefined}
      >
        {t('tabs.overview')}
      </Link>
      {SITE_TABS.map((tab) => {
        const href = `/dashboard/sites/${siteId}/${tab.slug}`;
        const active = pathname === href;
        return (
          <Link
            key={tab.slug}
            href={href}
            className={linkCls(active)}
            aria-current={active ? 'page' : undefined}
          >
            {t(tab.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}
