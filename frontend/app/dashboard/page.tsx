'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { sitesApi, ApiError, type Site } from '@/lib/api';
import { useErrorReporter } from '@/components/ErrorBanner';
import AddSiteForm from '@/components/AddSiteForm';
import { SiteGridSkeleton } from '@/components/Skeleton';

export default function DashboardPage() {
  const { report } = useErrorReporter();
  const router = useRouter();
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const res = await sitesApi.list();
      setSites(res.data);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        router.push('/login?next=/dashboard');
      } else {
        report(e);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async (site: Site) => {
    if (!confirm(`Remove ${site.domain}? This deletes all its SEO data.`)) return;
    try {
      await sitesApi.remove(site.id);
      setSites((prev) => prev.filter((s) => s.id !== site.id));
    } catch (e) {
      report(e);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="bx-micro mb-1">~/ sites</p>
          <h1 className="bx-h1">Your sites</h1>
        </div>
        <Link href="/dashboard/sites/new" className="bx-btn-primary">
          Add site (guided)
        </Link>
      </div>

      <div className="bx-card">
        <p className="bx-micro mb-3">~/ quick add</p>
        <AddSiteForm onAdded={load} />
      </div>

      {loading ? (
        <SiteGridSkeleton />
      ) : sites.length === 0 ? (
        <div className="bx-empty">
          <p className="text-sm font-medium text-white">No sites yet</p>
          <p className="mt-1 text-sm text-white/50">
            Add your first site to run a health audit and start tracking keywords.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sites.map((s) => (
            <div key={s.id} className="bx-card">
              <div className="flex items-start justify-between gap-2">
                <Link
                  href={`/dashboard/sites/${s.id}`}
                  className="truncate font-mono text-base font-semibold text-white hover:text-teal-300"
                >
                  {s.domain}
                </Link>
                <button
                  onClick={() => remove(s)}
                  className="shrink-0 text-xs font-medium text-red-300/80 hover:text-red-300 hover:underline"
                >
                  Remove
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className={`bx-pill ${s.verified ? 'bx-pill-ok' : 'bx-pill-warn'}`}>
                  <span className="bx-dot" />
                  {s.verified ? 'Verified' : 'Not verified'}
                </span>
                <span className={`bx-pill ${s.gsc_connected ? 'bx-pill-ok' : 'bx-pill-info'}`}>
                  <span className="bx-dot" />
                  {s.gsc_connected ? 'Search Console connected' : 'Search Console not connected'}
                </span>
              </div>
              <Link
                href={s.verified ? `/dashboard/sites/${s.id}` : `/dashboard/sites/new?siteId=${s.id}`}
                className="bx-btn-secondary mt-4 inline-flex !px-3 !py-1.5 !text-sm"
              >
                {s.verified ? 'Open dashboard' : 'Finish setup'}
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
