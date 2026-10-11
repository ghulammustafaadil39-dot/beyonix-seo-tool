'use client';

import { useEffect, useState } from 'react';
import { withMockFallback, notLandedYet } from '@/lib/mock';
import {
  mockCompetitors,
  mockContentGaps,
  type Competitor,
  type CompetitorGap,
} from '@/lib/mock/competitors';
import MockBanner from '@/components/MockBanner';

/**
 * F-07 — Competitor analysis tab. Add competitors, compare visibility,
 * keyword overlap, content gaps, and backlinks.
 * Fully mock-backed (bannered) until the endpoints land.
 */
export default function CompetitorsTab({ siteId }: { siteId: string }) {
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [gaps, setGaps] = useState<CompetitorGap[]>([]);
  const [newDomain, setNewDomain] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      const [c, g] = await Promise.all([
        withMockFallback(() => notLandedYet<Competitor[]>(), mockCompetitors),
        withMockFallback(() => notLandedYet<CompetitorGap[]>(), mockContentGaps),
      ]);
      setCompetitors(c.data);
      setGaps(g.data);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  const addCompetitor = (e: React.FormEvent) => {
    e.preventDefault();
    const domain = newDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      setErr('Enter a valid domain, e.g. competitor.com');
      return;
    }
    if (competitors.some((c) => c.domain === domain)) {
      setErr('That competitor is already tracked.');
      return;
    }
    setErr('');
    setCompetitors((prev) => [
      ...prev,
      {
        id: `local_${Date.now()}`,
        domain,
        visibility: 0,
        keywords_overlap: 0,
        backlinks: 0,
        added_at: new Date().toISOString(),
      },
    ]);
    setNewDomain('');
  };

  const remove = (id: string) => setCompetitors((prev) => prev.filter((c) => c.id !== id));
  const maxVis = Math.max(1, ...competitors.map((c) => c.visibility));

  return (
    <div className="space-y-6">
      <div><MockBanner label="competitor analysis" /></div>

      {/* Add competitor */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ competitors</p>
        <h2 className="text-base font-bold text-white">Tracked competitors</h2>
        <form onSubmit={addCompetitor} className="mt-3 flex gap-2">
          <input
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder="competitor.com"
            className="bx-input font-mono"
            aria-label="Competitor domain"
          />
          <button type="submit" className="bx-btn-primary shrink-0">
            Add
          </button>
        </form>
        {err && <p className="bx-alert-err mt-3" role="alert">{err}</p>}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {competitors.map((c) => (
            <div key={c.id} className="bx-panel">
              <div className="flex items-start justify-between gap-2">
                <p className="font-mono text-sm font-semibold text-white">{c.domain}</p>
                <button
                  onClick={() => remove(c.id)}
                  className="text-xs text-red-300/80 hover:text-red-300 hover:underline"
                  aria-label={`Remove ${c.domain}`}
                >
                  Remove
                </button>
              </div>
              <div className="mt-3">
                <div className="flex justify-between text-xs">
                  <span className="text-white/50">Visibility</span>
                  <span className="font-mono text-white/70">{c.visibility}/100</span>
                </div>
                <div className="bx-meter-track">
                  <div className="bx-meter-fill" style={{ width: `${(c.visibility / maxVis) * 100}%` }} />
                </div>
              </div>
              <div className="mt-2 flex gap-4 font-mono text-xs text-white/40">
                <span>{c.keywords_overlap} shared keywords</span>
                <span>{c.backlinks.toLocaleString()} backlinks</span>
              </div>
            </div>
          ))}
          {competitors.length === 0 && (
            <p className="text-sm text-white/40">No competitors yet — add one above.</p>
          )}
        </div>
      </div>

      {/* Content gaps */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ content gaps</p>
        <h2 className="text-base font-bold text-white">Keywords they rank for, you don&rsquo;t</h2>
        <div className="bx-table-wrap mt-3">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-white/10">
                <th className="bx-th">Keyword</th>
                <th className="bx-th">Volume</th>
                <th className="bx-th">Their position</th>
                <th className="bx-th">Your position</th>
              </tr>
            </thead>
            <tbody className="bx-tbody">
              {gaps.map((g) => (
                <tr key={g.keyword}>
                  <td className="px-4 py-3 font-mono text-white/85">{g.keyword}</td>
                  <td className="px-4 py-3 font-mono text-white/60">{g.volume.toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <span className="bx-pill bx-pill-ok">
                      <span className="bx-dot" />
                      #{g.their_position}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-white/60">
                    {g.your_position === null ? '—' : `#${g.your_position}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
