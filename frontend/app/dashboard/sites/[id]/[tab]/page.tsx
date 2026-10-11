'use client';

import { useEffect, useState } from 'react';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import TabNav, { SITE_TABS } from '@/components/TabNav';
import { sitesApi, type Site } from '@/lib/api';
import { useErrorReporter } from '@/components/ErrorBanner';
import AuditTab from '@/components/tabs/AuditTab';
import KeywordsTab from '@/components/tabs/KeywordsTab';
import RankingsTab from '@/components/tabs/RankingsTab';
import ContentTab from '@/components/tabs/ContentTab';
import OnpageTab from '@/components/tabs/OnpageTab';
import BacklinksTab from '@/components/tabs/BacklinksTab';
import GeoTab from '@/components/tabs/GeoTab';
import CompetitorsTab from '@/components/tabs/CompetitorsTab';
import ReportsTab from '@/components/tabs/ReportsTab';

const TAB_COMPONENTS: Record<string, (props: { siteId: string }) => React.JSX.Element> = {
  audit: AuditTab,
  keywords: KeywordsTab,
  rankings: RankingsTab,
  content: ContentTab,
  onpage: OnpageTab,
  backlinks: BacklinksTab,
  geo: GeoTab,
  competitors: CompetitorsTab,
  reports: ReportsTab,
};

export default function SiteTabPage({
  params,
}: {
  params: { id: string; tab: string };
}) {
  const { id: siteId, tab } = params;
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
      <nav className="flex items-center gap-2 font-mono text-sm text-white/40">
        <Link href="/dashboard" className="hover:text-white/70 hover:underline">
          Sites
        </Link>
        <span>/</span>
        <Link href={`/dashboard/sites/${siteId}`} className="hover:text-white/70 hover:underline">
          {site ? site.domain : '…'}
        </Link>
        <span>/</span>
        <span className="font-medium text-teal-300">{meta.label}</span>
      </nav>
      <TabNav siteId={siteId} />
      <h1 className="bx-h2">{meta.label}</h1>
      <Tab siteId={siteId} />
    </div>
  );
}
