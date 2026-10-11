'use client';

import { useEffect, useState } from 'react';
import { backlinksApi, type Backlink } from '@/lib/api';
import { useErrorReporter } from '../ErrorBanner';
import dynamic from 'next/dynamic';
const BacklinksV2Panel = dynamic(() => import('./BacklinksV2Panel').then((m) => m.default), {
  loading: () => <div role="status" aria-label="Loading advanced panel" className="bx-panel"><div className="bx-shimmer h-24 rounded-md bg-white/5" aria-hidden="true" /></div>,
  ssr: false,
});

export default function BacklinksTab({ siteId }: { siteId: string }) {
  const { report } = useErrorReporter();
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await backlinksApi.list(siteId, statusFilter || undefined);
      setBacklinks(res.data);
    } catch (e) {
      report(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, statusFilter]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await backlinksApi.refresh(siteId);
      await load();
    } catch (e) {
      report(e);
    } finally {
      setRefreshing(false);
    }
  };

  const uploadCsv = async (file: File) => {
    setUploading(true);
    setUploadMsg(null);
    try {
      const csv = await file.text();
      const res = await backlinksApi.upload(siteId, csv);
      setUploadMsg(`Imported ${res.imported} backlink${res.imported === 1 ? '' : 's'}.`);
      await load();
    } catch (e) {
      report(e);
    } finally {
      setUploading(false);
    }
  };

  if (loading) return <p className="font-mono text-sm text-white/55">$ loading backlinks…</p>;

  return (
    <div className="space-y-4">
      <div className="bx-panel text-sm text-white/60">
        <p className="bx-micro mb-1">~/ data source</p>
        <p className="font-semibold text-white">Where do backlinks come from?</p>
        <p className="mt-1">
          Export them from Google Search Console (Links → Top linking pages → Export CSV),
          then upload the file here. We track new and lost links across your uploads.
        </p>
        <label className="bx-btn-primary mt-3 inline-flex cursor-pointer">
          {uploading ? 'Uploading…' : 'Upload backlink CSV'}
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadCsv(f);
              e.target.value = '';
            }}
          />
        </label>
        {uploadMsg && <p className="mt-2 text-sm font-medium text-teal-300">{uploadMsg}</p>}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bx-input !w-auto"
          aria-label="Filter backlinks by status"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="lost">Lost</option>
        </select>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="bx-btn-primary"
        >
          {refreshing ? 'Refreshing…' : 'Refresh backlinks'}
        </button>
      </div>

      <div className="bx-table-wrap">
        <table className="min-w-full">
          <thead className="border-b border-white/10 bg-white/[0.03]">
            <tr>
              <th className="bx-th">Source URL</th>
              <th className="bx-th">Target URL</th>
              <th className="bx-th">First seen</th>
              <th className="bx-th">Last seen</th>
              <th className="bx-th">Status</th>
            </tr>
          </thead>
          <tbody className="bx-tbody">
            {backlinks.map((b) => (
              <tr key={b.id} className="transition hover:bg-white/[0.02]">
                <td className="max-w-[280px] truncate px-4 py-3 font-mono text-xs text-teal-300">
                  <a href={b.source_url} target="_blank" rel="noreferrer" className="hover:underline">
                    {b.source_url}
                  </a>
                </td>
                <td className="max-w-[280px] truncate px-4 py-3 font-mono text-xs text-white/55">
                  {b.target_url}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-white/55">
                  {new Date(b.first_seen).toLocaleDateString()}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-white/55">
                  {new Date(b.last_seen).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <span className={`bx-pill ${b.status === 'active' ? 'bx-pill-ok' : 'bx-pill-err'}`}>
                    <span className="bx-dot" />
                    {b.status}
                  </span>
                </td>
              </tr>
            ))}
            {backlinks.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-white/55">
                  No backlinks yet. Upload a CSV exported from Google Search Console
                  (Links → Top linking pages → Export) to start tracking.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <BacklinksV2Panel siteId={siteId} />
    </div>
  );
}
