'use client';

import { useEffect, useState } from 'react';
import { keywordsApi, sitesApi, type Keyword } from '@/lib/api';
import { useErrorReporter } from '../ErrorBanner';
import KeywordsV2Panel from './KeywordsV2Panel';

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
      <p className="mb-3 text-xs text-white/40">
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
      await keywordsApi.research(siteId, seedList);
      setSeeds('');
      load(trackedOnly || undefined);
    } catch (err) {
      report(err);
    } finally {
      setResearching(false);
    }
  };

  const track = async (kw: Keyword) => {
    try {
      const updated = await keywordsApi.track(kw.id);
      setKeywords((prev) => prev.map((k) => (k.id === kw.id ? updated : k)));
    } catch (err) {
      report(err);
    }
  };

  const untrack = async (kw: Keyword) => {
    try {
      const updated = await keywordsApi.untrack(kw.id);
      setKeywords((prev) =>
        trackedOnly ? prev.filter((k) => k.id !== kw.id) : prev.map((k) => (k.id === kw.id ? updated : k)),
      );
    } catch (err) {
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
        <span className="font-mono text-xs text-white/30">{keywords.length} keywords</span>
      </div>

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
                Priority <span className="normal-case text-white/30" title="Higher volume + lower difficulty = higher priority. Start with the highest numbers.">ⓘ</span>
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
                <td className="px-4 py-3 text-xs text-white/40">{k.intent ?? '—'}</td>
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
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-white/40">
                  No keywords yet — run research above to discover some.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <KeywordsV2Panel siteId={siteId} />
    </div>
  );
}
