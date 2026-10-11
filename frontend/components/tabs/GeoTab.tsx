'use client';

import { useEffect, useState } from 'react';
import { geoApi, type GeoScore } from '@/lib/api';
import { useErrorReporter } from '../ErrorBanner';
import ScoreGauge from '../ScoreGauge';
import GeoV2Panel from './GeoV2Panel';

// Must match the backend allowlist in routes/geo.ts (GEO_PLATFORMS_ALLOWED).
const PLATFORMS = ['chatgpt', 'perplexity', 'gemini', 'ai_overview'];
const PLATFORM_LABELS: Record<string, string> = {
  chatgpt: 'ChatGPT',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
  ai_overview: 'Google AI Overview',
};

export default function GeoTab({ siteId }: { siteId: string }) {
  const { report } = useErrorReporter();
  const [geo, setGeo] = useState<GeoScore | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [platforms, setPlatforms] = useState<string[]>(['chatgpt']);
  const [checking, setChecking] = useState(false);

  const load = async () => {
    try {
      const res = await geoApi.score(siteId);
      setGeo(res);
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

  const togglePlatform = (p: string) =>
    setPlatforms((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  const runCheck = async (e: React.FormEvent) => {
    e.preventDefault();
    if (platforms.length === 0) return;
    setChecking(true);
    try {
      await geoApi.check(siteId, { query: query.trim(), platforms });
      setQuery('');
      await load();
    } catch (err) {
      report(err);
    } finally {
      setChecking(false);
    }
  };

  if (loading) return <p className="font-mono text-sm text-white/40">$ loading GEO data…</p>;

  return (
    <div className="space-y-6">
      <div className="bx-card bx-glow">
        <div className="relative">
          <p className="bx-micro mb-3">~/ ai visibility</p>
          <ScoreGauge score={geo?.score ?? null} label="GEO visibility score" />
          <p className="mt-3 text-xs text-white/40">
            How often AI assistants mention your brand in answers to relevant queries.
            <span className="font-medium text-amber-300"> Simulated estimate</span> — our AI approximates each
            platform's likely answer; spot-check important queries manually.
          </p>
        </div>
      </div>

      <div className="bx-card">
        <p className="bx-micro mb-1">~/ run check</p>
        <h3 className="mb-3 text-sm font-semibold text-white">Run a GEO check</h3>
        <form onSubmit={runCheck} className="space-y-3">
          <input
            type="text"
            required
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. best accounting software for freelancers"
            className="bx-input"
          />
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map((p) => (
              <label
                key={p}
                className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-medium capitalize transition ${
                  platforms.includes(p)
                    ? 'border-teal-400/40 bg-teal-400/10 text-teal-200'
                    : 'border-white/10 text-white/40 hover:bg-white/5'
                }`}
              >
                <input
                  type="checkbox"
                  checked={platforms.includes(p)}
                  onChange={() => togglePlatform(p)}
                  className="sr-only"
                />
                {PLATFORM_LABELS[p] ?? p}
              </label>
            ))}
          </div>
          <button
            type="submit"
            disabled={checking}
            className="bx-btn-primary"
          >
            {checking ? 'Checking…' : 'Run check'}
          </button>
        </form>
      </div>

      <div className="bx-table-wrap">
        <table className="min-w-full">
          <thead className="border-b border-white/10 bg-white/[0.03]">
            <tr>
              <th className="bx-th">Query</th>
              <th className="bx-th">Platform</th>
              <th className="bx-th">Mentioned</th>
              <th className="bx-th">Context</th>
              <th className="bx-th">Checked</th>
            </tr>
          </thead>
          <tbody className="bx-tbody">
            {(geo?.checks ?? []).map((c) => (
              <tr key={c.id} className="transition hover:bg-white/[0.02]">
                <td className="px-4 py-3 text-sm font-medium text-white">{c.query}</td>
                <td className="px-4 py-3 text-xs capitalize text-white/40">{c.platform}</td>
                <td className="px-4 py-3">
                  {c.mentioned === null ? (
                    <span className="font-mono text-xs text-white/30">pending</span>
                  ) : (
                    <span className={`bx-pill ${c.mentioned ? 'bx-pill-ok' : 'bx-pill-info'}`}>
                      <span className="bx-dot" />
                      {c.mentioned ? 'Yes' : 'No'}
                    </span>
                  )}
                </td>
                <td className="max-w-[280px] truncate px-4 py-3 text-xs text-white/40">
                  {c.context_snippet ?? '—'}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-white/40">
                  {new Date(c.checked_at).toLocaleString()}
                </td>
              </tr>
            ))}
            {(geo?.checks ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-white/40">
                  No GEO checks yet — run your first check above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <GeoV2Panel siteId={siteId} />
    </div>
  );
}
