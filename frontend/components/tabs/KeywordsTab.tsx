'use client';

import { useEffect, useState } from 'react';
import { keywordsApi, sitesApi, type DataSource, type Keyword } from '@/lib/api';
import { useErrorReporter } from '../ErrorBanner';
import { TableSkeleton } from '../Skeleton';
import dynamic from 'next/dynamic';
const KeywordsV2Panel = dynamic(() => import('./KeywordsV2Panel').then((m) => m.default), {
  loading: () => <div role="status" aria-label="Loading advanced panel" className="bx-panel"><div className="bx-shimmer h-24 rounded-md bg-white/5" aria-hidden="true" /></div>,
  ssr: false,
});

interface GscQuery {
  query: string;
  clicks: number;
  impressions: number;
  position: number;
}

/** Real Google Search Console data: what people actually searched to find the site. */
function GscQueriesCard({ siteId }: { siteId: string }) {
  const [queries, setQueries] = useState<GscQuery[] | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await sitesApi.gscQueries(siteId);
        setQueries(res.data);
      } catch {
        // GSC not connected (400) or no data — card simply stays hidden.
        setQueries(null);
      }
    })();
  }, [siteId]);

  if (!queries || queries.length === 0) return null;

  return (
    <div className="bx-card">
      <p className="bx-micro mb-1">~/ search console</p>
      <h3 className="mb-1 text-sm font-semibold text-white">
        Top Google Search Console queries
      </h3>
      <p className="mb-3 text-xs text-white/55">
        Real searches that showed your site on Google in the last 28 days — great seeds for tracking.
      </p>
      <div className="bx-table-wrap !rounded-lg">
        <table className="min-w-full">
          <thead className="border-b border-white/10 bg-white/[0.03]">
            <tr>
              <th className="bx-th">Query</th>
              <th className="bx-th">Clicks</th>
              <th className="bx-th">Impressions</th>
              <th className="bx-th">Avg. position</th>
            </tr>
          </thead>
          <tbody className="bx-tbody">
            {queries.slice(0, 10).map((q, i) => (
              <tr key={i}>
                <td className="px-4 py-2 text-sm font-medium text-white">{q.query}</td>
                <td className="px-4 py-2 font-mono text-sm text-white/70">{q.clicks}</td>
                <td className="px-4 py-2 font-mono text-sm text-white/70">{q.impressions}</td>
                <td className="px-4 py-2 font-mono text-sm text-white/70">{q.position.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function KeywordsTab({ siteId }: { siteId: string }) {
  const { report } = useErrorReporter();
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [loading, setLoading] = useState(true);
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [seeds, setSeeds] = useState('');
  const [researching, setResearching] = useState(false);
  // A3-M2: provenance of the volume/difficulty numbers from the last
  // research run in this session ('mock' = seeded, no DataForSEO key).
  // The keyword-list endpoint does not return provenance, so this only
  // covers numbers produced by research above; the gap panel labels its
  // own results the same way.
  const [researchSource, setResearchSource] = useState<DataSource | null>(null);

  const load = async (tracked?: boolean) => {
    try {
      const res = await keywordsApi.list(siteId, tracked);
      setKeywords(res.data);
    } catch (e) {
      report(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    load(trackedOnly || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, trackedOnly]);

  const research = async (e: React.FormEvent) => {
    e.preventDefault();
    const seedList = seeds.split('\n').map((s) => s.trim()).filter(Boolean);
    if (seedList.length === 0) return;
    setResearching(true);
    try {
      const res = await keywordsApi.research(siteId, seedList);
      setResearchSource(res.dataSource ?? null);
      setSeeds('');
      load(trackedOnly || undefined);
    } catch (err) {
      report(err);
    } finally {
      setResearching(false);
    }
  };

  // W-05: optimistic UI for track/untrack (cheap, reversible) —
  // the row flips instantly and rolls back on error.
  const track = async (kw: Keyword) => {
    const prev = keywords;
    setKeywords((cur) => cur.map((k) => (k.id === kw.id ? { ...k, tracked: true } : k)));
    try {
      const updated = await keywordsApi.track(kw.id);
      setKeywords((cur) => cur.map((k) => (k.id === kw.id ? updated : k)));
    } catch (err) {
      setKeywords(prev);
      report(err);
    }
  };

  const untrack = async (kw: Keyword) => {
    const prev = keywords;
    setKeywords((cur) =>
      trackedOnly ? cur.filter((k) => k.id !== kw.id) : cur.map((k) => (k.id === kw.id ? { ...k, tracked: false } : k)),
    );
    try {
      const updated = await keywordsApi.untrack(kw.id);
      setKeywords((cur) =>
        trackedOnly ? cur.filter((k) => k.id !== kw.id) : cur.map((k) => (k.id === kw.id ? updated : k)),
      );
    } catch (err) {
      setKeywords(prev);
      report(err);
    }
  };

  const remove = async (kw: Keyword) => {
    if (!confirm(`Delete "${kw.keyword}"?`)) return;
    try {
      await keywordsApi.remove(kw.id);
      setKeywords((prev) => prev.filter((k) => k.id !== kw.id));
    } catch (err) {
      report(err);
    }
  };

  return (
    <div className="space-y-6">
      <GscQueriesCard siteId={siteId} />

      <div className="bx-card">
        <p className="bx-micro mb-2">~/ research</p>
        <h3 className="mb-2 text-sm font-semibold text-white">Keyword research</h3>
        <form onSubmit={research} className="flex flex-col gap-2 sm:flex-row">
          <textarea
            value={seeds}
            onChange={(e) => setSeeds(e.target.value)}
            rows={2}
            placeholder={'One seed keyword per line\n(e.g. best crm for small business)'}
            className="bx-input font-mono"
          />
          <button
            type="submit"
            disabled={researching}
            className="bx-btn-primary shrink-0"
          >
            {researching ? 'Researching…' : 'Research'}
          </button>
        </form>
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-white/60">
          <input
            type="checkbox"
            checked={trackedOnly}
            onChange={(e) => setTrackedOnly(e.target.checked)}
            className="h-4 w-4 accent-teal-400"
          />
          Show tracked only
        </label>
        <span className="font-mono text-xs text-white/50">{keywords.length} keywords</span>
      </div>

      {researchSource === 'mock' && (
        <p className="bx-alert-info">
          Volume &amp; difficulty are mock estimates (no DataForSEO key configured) —
          treat them as illustrative. Add DataForSEO keys for live data.
        </p>
      )}

      {loading ? (
        <TableSkeleton rows={6} cols={7} />
      ) : (
      <div className="bx-table-wrap">
        <table className="min-w-full">
          <thead className="border-b border-white/10 bg-white/[0.03]">
            <tr>
              <th className="bx-th">Keyword</th>
              <th className="bx-th">Topic</th>
              <th className="bx-th">Volume</th>
              <th className="bx-th">Difficulty</th>
              <th className="bx-th">Intent</th>
              <th className="bx-th" title="Priority score (0–100): higher volume and lower difficulty score higher. Start with the highest.">
                Priority <span className="normal-case text-white/50" title="Higher volume + lower difficulty = higher priority. Start with the highest numbers.">ⓘ</span>
              </th>
              <th className="bx-th">Actions</th>
            </tr>
          </thead>
          <tbody className="bx-tbody">
            {keywords.map((k) => (
              <tr key={k.id} className="transition hover:bg-white/[0.02]">
                <td className="px-4 py-3 text-sm font-medium text-white">{k.keyword}</td>
                <td className="px-4 py-3">
                  <span className="bx-pill bx-pill-info">
                    {k.group_key ?? '—'}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-sm text-white/70">{k.volume ?? '—'}</td>
                <td className="px-4 py-3 font-mono text-sm text-white/70">{k.difficulty ?? '—'}</td>
                <td className="px-4 py-3 text-xs text-white/55">{k.intent ?? '—'}</td>
                <td className="px-4 py-3 font-mono text-sm text-teal-300">
                  {k.priority_score !== null ? k.priority_score.toFixed(1) : '—'}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    {k.tracked ? (
                      <button
                        onClick={() => untrack(k)}
                        className="bx-btn-xs-secondary"
                      >
                        Untrack
                      </button>
                    ) : (
                      <button
                        onClick={() => track(k)}
                        className="bx-btn-xs-primary"
                      >
                        Track
                      </button>
                    )}
                    <button
                      onClick={() => remove(k)}
                      className="bx-btn-xs-danger"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {keywords.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-white/55">
                  No keywords yet — run research above to discover some.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      )}

      <KeywordsV2Panel siteId={siteId} />
    </div>
  );
}
