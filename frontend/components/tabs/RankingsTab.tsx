'use client';

import { useEffect, useState } from 'react';
import { ranksApi, type DataSource, type RankEntry } from '@/lib/api';
import { useErrorReporter } from '../ErrorBanner';
import Sparkline from '../Sparkline';

const FEATURE_LABELS: Record<string, string> = {
  ai_overview: 'AI Overview',
  people_also_ask: 'People also ask',
  featured_snippet: 'Featured snippet',
  knowledge_panel: 'Knowledge panel',
  local_pack: 'Local pack',
  video: 'Video',
  images: 'Images',
};

function FeatureBadges({ features }: { features?: string[] }) {
  const list = (features ?? []).filter((f) => f && f !== 'organic');
  if (list.length === 0) return <span className="text-xs text-white/50">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {list.map((f) => (
        <span
          key={f}
          title={FEATURE_LABELS[f] ?? f}
          className={`bx-pill !text-[11px] ${f === 'ai_overview' ? 'bx-pill-violet' : 'bx-pill-sky'}`}
        >
          {FEATURE_LABELS[f] ?? f}
        </span>
      ))}
    </span>
  );
}

export default function RankingsTab({ siteId }: { siteId: string }) {
  const { report } = useErrorReporter();
  const [ranks, setRanks] = useState<RankEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [history, setHistory] = useState<Record<string, (number | null)[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  // A3-M1: provenance of the positions ('mock' = seeded, no DataForSEO key).
  const [dataSource, setDataSource] = useState<DataSource | null>(null);

  const load = async () => {
    try {
      const res = await ranksApi.latest(siteId);
      setRanks(res.data);
      setDataSource(res.dataSource ?? null);
    } catch (e) {
      report(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  const refresh = async () => {
    setRefreshing(true);
    setRefreshNote(null);
    try {
      await ranksApi.refresh(siteId);
      setRefreshNote('Refresh queued — rankings update in the background. Check back in a few minutes.');
      await load();
    } catch (e) {
      report(e);
    } finally {
      setRefreshing(false);
    }
  };

  const toggleHistory = async (entry: RankEntry) => {
    if (expanded === entry.keyword_id) {
      setExpanded(null);
      return;
    }
    setExpanded(entry.keyword_id);
    if (!history[entry.keyword_id]) {
      try {
        const res = await ranksApi.history(entry.keyword_id);
        setHistory((prev) => ({
          ...prev,
          [entry.keyword_id]: res.data.map((p) => p.position),
        }));
      } catch (e) {
        report(e);
      }
    }
  };

  if (loading) return <p className="font-mono text-sm text-white/55">$ loading rankings…</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="font-mono text-sm text-white/55">{ranks.length} tracked keywords</p>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="bx-btn-primary"
        >
          {refreshing ? 'Refreshing…' : 'Refresh rankings'}
        </button>
      </div>
      {refreshNote && (
        <p className="bx-alert-info">{refreshNote}</p>
      )}
      {dataSource === 'mock' && (
        <p className="bx-alert-info">
          Ranking positions are mock data (no DataForSEO key configured) — treat
          them as illustrative. Add DataForSEO keys for live rank tracking.
        </p>
      )}

      <div className="bx-table-wrap">
        <table className="min-w-full">
          <thead className="border-b border-white/10 bg-white/[0.03]">
            <tr>
              <th className="bx-th">Keyword</th>
              <th className="bx-th">Position</th>
              <th className="bx-th">SERP features</th>
              <th className="bx-th">URL</th>
              <th className="bx-th">Last checked</th>
              <th className="bx-th">Trend</th>
              <th className="bx-th" />
            </tr>
          </thead>
          <tbody className="bx-tbody">
            {ranks.map((r) => (
              <tr key={r.keyword_id} className="transition hover:bg-white/[0.02]">
                <td className="px-4 py-3 text-sm font-medium text-white">{r.keyword}</td>
                <td className="px-4 py-3">
                  <span
                    className={`bx-pill !font-mono !font-bold ${
                      r.position !== null && r.position <= 10
                        ? 'bx-pill-ok'
                        : r.position !== null && r.position <= 30
                          ? 'bx-pill-warn'
                          : 'bx-pill-info'
                    }`}
                  >
                    {r.position ?? '—'}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <FeatureBadges features={r.serp_features} />
                </td>
                <td className="max-w-[240px] truncate px-4 py-3 font-mono text-xs text-white/55">
                  {r.url ?? '—'}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-white/55">
                  {r.checked_at ? new Date(r.checked_at).toLocaleString() : '—'}
                </td>
                <td className="px-4 py-3">
                  <Sparkline points={r.spark ?? history[r.keyword_id] ?? []} />
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => toggleHistory(r)}
                    className="bx-link text-xs"
                  >
                    {expanded === r.keyword_id ? 'Hide' : 'History'}
                  </button>
                </td>
              </tr>
            ))}
            {ranks.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-white/55">
                  No tracked keywords yet. Track keywords from the Keywords tab.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
