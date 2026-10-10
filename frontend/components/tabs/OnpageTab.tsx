'use client';

import { useState } from 'react';
import { onpageApi, type OnpageSuggestion } from '@/lib/api';
import { useErrorReporter } from '../ErrorBanner';

export default function OnpageTab({ siteId }: { siteId: string }) {
  const { report } = useErrorReporter();
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OnpageSuggestion | null>(null);

  const analyze = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    try {
      const res = await onpageApi.analyze(siteId, url.trim());
      setResult(res);
    } catch (err) {
      report(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ analyzer</p>
        <h3 className="mb-2 text-sm font-semibold text-white">Analyze a page</h3>
        <form onSubmit={analyze} className="flex flex-col gap-2 sm:flex-row">
          <input
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/blog/post"
            className="bx-input font-mono"
          />
          <button
            type="submit"
            disabled={loading}
            className="bx-btn-primary shrink-0"
          >
            {loading ? 'Analyzing…' : 'Analyze'}
          </button>
        </form>
        <p className="bx-hint mt-2">
          Fetches the URL and returns AI-powered on-page optimization suggestions.
        </p>
      </div>

      {result && (
        <div className="space-y-4">
          <div className="bx-card">
            <div className="flex flex-wrap items-center gap-4">
              <div
                className={`flex h-16 w-16 items-center justify-center rounded-full border font-mono text-2xl font-bold ${
                  result.quality.score >= 85
                    ? 'border-teal-400/40 bg-teal-400/10 text-teal-300 shadow-[0_0_24px_rgba(45,212,191,0.25)]'
                    : result.quality.score >= 70
                      ? 'border-lime-400/40 bg-lime-400/10 text-lime-300'
                      : result.quality.score >= 55
                        ? 'border-amber-400/40 bg-amber-400/10 text-amber-300'
                        : result.quality.score >= 40
                          ? 'border-orange-400/40 bg-orange-400/10 text-orange-300'
                          : 'border-red-400/40 bg-red-400/10 text-red-300'
                }`}
              >
                {result.quality.grade}
              </div>
              <div>
                <p className="text-sm font-semibold text-white">
                  Page quality score: <span className="font-mono">{result.quality.score}/100</span>
                </p>
                <p className="text-xs text-white/40">
                  A simple grade for how well this page is optimized — fix the items below to raise it.
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {result.quality.breakdown.map((b, i) => (
                <div key={i} className="bx-panel flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-white/80">{b.label}</p>
                    <p className="text-xs text-white/40">{b.note}</p>
                  </div>
                  <span className="shrink-0 font-mono text-xs font-bold text-teal-300">
                    {b.points}/{b.max}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="bx-card">
            <p className="bx-micro mb-3">~/ suggestions</p>
            <h3 className="mb-3 text-sm font-semibold text-white">
              Suggestions for <span className="font-mono font-normal text-white/40">{result.url}</span>
            </h3>
            <div className="space-y-4">
              {result.suggestions.map((s, i) => (
                <div key={i} className="bx-panel">
                  <p className="text-sm font-semibold text-teal-300">{s.area}</p>
                  {s.current && (
                    <p className="mt-1 text-xs text-white/40">
                      <strong className="text-white/60">Current:</strong> {s.current}
                    </p>
                  )}
                  {s.suggested && (
                    <p className="mt-1 text-sm text-white/85">
                      <strong className="text-white">Suggested:</strong> {s.suggested}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-white/60">{s.note}</p>
                </div>
              ))}
              {result.suggestions.length === 0 && (
                <p className="text-sm text-white/40">No suggestions — this page looks good.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
