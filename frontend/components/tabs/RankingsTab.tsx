'use client';

import { useEffect, useState } from 'react';
import { ranksApi, type DataSource, type RankAlert, type RankEntry } from '@/lib/api';
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

/** Phase 7: position change arrow vs previous check (beginner-friendly). */
function ChangeArrow({ entry }: { entry: RankEntry }) {
  const { position, prev_position } = entry;
  if (prev_position == null || position == null) {
    if (prev_position == null && position != null)
      return <span className="bx-pill bx-pill-ok !font-mono !text-xs">new</span>;
    return <span className="text-xs text-white/50">—</span>;
  }
  const delta = prev_position - position;
  if (delta === 0) return <span className="font-mono text-xs text-white/50">=</span>;
  const up = delta > 0;
  return (
    <span
      className={`font-mono text-xs font-bold ${up ? 'text-teal-300' : 'text-red-300'}`}
      title={`Was #${prev_position}, now #${position}`}
    >
      {up ? '▲' : '▼'} {Math.abs(delta)}
    </span>
  );
}

/** Phase 7: recent rank alerts with beginner-friendly reasons. */
function AlertsSection({ alerts }: { alerts: RankAlert[] }) {
  const drops = alerts.filter((a) => a.direction === 'dropped').slice(0, 5);
  if (drops.length === 0) return null;
  return (
    <div className="bx-card border-red-400/20">
      <h3 className="mb-2 text-sm font-semibold text-red-200">
        ⚠ {drops.length} keyword{drops.length > 1 ? 's' : ''} dropped recently
      </h3>
      <ul className="space-y-2">
        {drops.map((a) => (
          <li key={a.id} className="text-sm">
            <span className="font-medium text-white">{a.keyword}</span>{' '}
            <span className="font-mono text-xs text-white/60">
              #{a.prev_position ?? '?'} → {a.position == null ? 'out of top 10' : `#${a.position}`}
            </span>
            {a.reason && <p className="mt-0.5 text-xs text-white/60">{a.reason}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function RankingsTab({ siteId }: { siteId: string }) {
  const { report } = useErrorReporter();
  const [ranks, setRanks] = useState<RankEntry[]>([]);
  const [alerts, setAlerts] = useState<RankAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [history, setHistory] = useState<Record<string, (number | null)[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  // Phase 7: positions are measured live via free search (never mock).
  const [dataSource, setDataSource] = useState<DataSource | null>(null);

  const load = async () => {
    try {
      const [res, al] = await Promise.all([ranksApi.latest(siteId), ranksApi.alerts(siteId, 20)]);
      setRanks(res.data);
      setDataSource(res.dataSource ?? null);
      setAlerts(al.data);
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
      // Phase 7: dedicated check endpoint (bodyless POST, free provider).
      const res = await ranksApi.check(siteId);
      setRefreshNote(
        (res as { deduplicated?: boolean }).deduplicated
          ? 'Already checked today — rankings are up to date.'
          : 'Rank check queued — positions update in the background. Check back in a few minutes.',
      );
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
        const res = await ranksApi.historyBySite(siteId, entry.keyword_id);
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
        <button onClick={refresh} disabled={refreshing} className="bx-btn-primary">
          {refreshing ? 'Checking…' : 'Check rankings now'}
        </button>
      </div>
      {refreshNote && <p className="bx-alert-info">{refreshNote}</p>}
      <AlertsSection alerts={alerts} />
      {dataSource === 'mock' && (
        <p className="bx-alert-info">Ranking positions are mock data — treat them as illustrative.</p>
      )}
      {dataSource === 'real' && (
        <p className="font-mono text-[11px] text-white/40">
          Positions measured live from public search results (free, top 10) — updated daily.
        </p>
      )}

      <div className="bx-table-wrap">
        <table className="min-w-full">
          <thead className="border-b border-white/10 bg-white/[0.03]">
            <tr>
              <th className="bx-th">Keyword</th>
              <th className="bx-th">Position</th>
              <th className="bx-th">Change</th>
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
                  <ChangeArrow entry={r} />
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
                  <button onClick={() => toggleHistory(r)} className="bx-link text-xs">
                    {expanded === r.keyword_id ? 'Hide' : 'History'}
                  </button>
                </td>
              </tr>
            ))}
            {ranks.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-white/55">
                  No tracked keywords yet. Track keywords from the Keywords tab — positions check
                  automatically every day.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
