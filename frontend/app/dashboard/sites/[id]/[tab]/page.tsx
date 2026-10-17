// W-08: every site tab is code-split behind next/dynamic so visiting one
// tab no longer downloads all nine (plus the V2 panels, which split again
// inside each tab). W-04: 'insights' tab added.
'use client';

import dynamic from 'next/dynamic';
import { use, useEffect, useState } from 'react';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import TabNav, { SITE_TABS } from '@/components/TabNav';
import { sitesApi, type Site } from '@/lib/api';
import { useErrorReporter } from '@/components/ErrorBanner';
import { TableSkeleton } from '@/components/Skeleton';

const fallback = () => <TableSkeleton rows={6} cols={4} />;

// Explicit import paths (required — next/dynamic cannot bundle a
// template-literal import).
const TAB_COMPONENTS: Record<string, React.ComponentType<{ siteId: string }>> = {
  insights: dynamic(() => import('@/components/tabs/InsightsTab').then((m) => m.default), {
    loading: fallback,
    ssr: false,
  }),
  audit: dynamic(() => import('@/components/tabs/AuditTab').then((m) => m.default), {
    loading: fallback,
    ssr: false,
  }),
  keywords: dynamic(() => import('@/components/tabs/KeywordsTab').then((m) => m.default), {
    loading: fallback,
    ssr: false,
  }),
  rankings: dynamic(() => import('@/components/tabs/RankingsTab').then((m) => m.default), {
    loading: fallback,
    ssr: false,
  }),
  content: dynamic(() => import('@/components/tabs/ContentTab').then((m) => m.default), {
    loading: fallback,
    ssr: false,
  }),
  onpage: dynamic(() => import('@/components/tabs/OnpageTab').then((m) => m.default), {
    loading: fallback,
    ssr: false,
  }),
  backlinks: dynamic(() => import('@/components/tabs/BacklinksTab').then((m) => m.default), {
    loading: fallback,
    ssr: false,
  }),
  geo: dynamic(() => import('@/components/tabs/GeoTab').then((m) => m.default), {
    loading: fallback,
    ssr: false,
  }),
  competitors: dynamic(() => import('@/components/tabs/CompetitorsTab').then((m) => m.default), {
    loading: fallback,
    ssr: false,
  }),
  reports: dynamic(() => import('@/components/tabs/ReportsTab').then((m) => m.default), {
    loading: fallback,
    ssr: false,
  }),
  autopilot: dynamic(() => import('@/components/tabs/AutopilotTab').then((m) => m.default), {
    loading: fallback,
    ssr: false,
  }),
};

export default function SiteTabPage({
  params,
}: {
  params: Promise<{ id: string; tab: string }>;
}) {
  const { id: siteId, tab } = use(params);
  const meta = SITE_TABS.find((t) => t.slug === tab);
  const Tab = TAB_COMPONENTS[tab];
  const { report } = useErrorReporter();
  const [site, setSite] = useState<Site | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setSite(await sitesApi.get(siteId));
      } catch (e) {
        report(e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  if (!meta || !Tab) notFound();

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 font-mono text-sm text-white/55">
        <Link href="/dashboard" className="hover:text-white/70 hover:underline">
          Sites
        </Link>
        <span aria-hidden="true">/</span>
        <Link href={`/dashboard/sites/${siteId}`} className="hover:text-white/70 hover:underline">
          {site ? site.domain : '…'}
        </Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page" className="font-medium text-teal-300">
          {meta.label}
        </span>
      </nav>
      <TabNav siteId={siteId} />
      <h1 className="bx-h2">{meta.label}</h1>
      <Tab siteId={siteId} />
    </div>
  );
}
