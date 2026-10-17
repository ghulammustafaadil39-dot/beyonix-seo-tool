'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  onpageApi,
  type OnpagePageAnalysis,
  type OnpagePageSummary,
  type OnpageSuggestion,
} from '@/lib/api';
import { useErrorReporter } from '../ErrorBanner';

const STATUS_ICON: Record<string, string> = { pass: '✅', warn: '⚠️', fail: '❌' };
const STATUS_BORDER: Record<string, string> = {
  pass: 'border-teal-400/25',
  warn: 'border-amber-400/25',
  fail: 'border-red-400/25',
};

function gradeColor(grade: string): string {
  if (grade === 'A') return 'border-teal-400/40 bg-teal-400/10 text-teal-300';
  if (grade === 'B') return 'border-lime-400/40 bg-lime-400/10 text-lime-300';
  if (grade === 'C') return 'border-amber-400/40 bg-amber-400/10 text-amber-300';
  if (grade === 'D') return 'border-orange-400/40 bg-orange-400/10 text-orange-300';
  return 'border-red-400/40 bg-red-400/10 text-red-300';
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return u.hostname + path;
  } catch {
    return url;
  }
}

export default function OnpageTab({ siteId }: { siteId: string }) {
  const { report } = useErrorReporter();

  // ---- Phase 8: automatic per-page analysis from the audit crawl ----
  const [pages, setPages] = useState<OnpagePageSummary[] | null>(null);
  const [pagesLoading, setPagesLoading] = useState(true);
  const [noAudit, setNoAudit] = useState(false);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [detail, setDetail] = useState<OnpagePageAnalysis | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // ---- Manual single-page check (secondary, kept for ad-hoc URLs) ----
  const [showManual, setShowManual] = useState(false);
  const [manualUrl, setManualUrl] = useState('');
  const [manualLoading, setManualLoading] = useState(false);
  const [manualResult, setManualResult] = useState<OnpageSuggestion | null>(null);

  const loadPages = useCallback(async () => {
    setPagesLoading(true);
    setNoAudit(false);
    try {
      const res = await onpageApi.pages(siteId);
      setPages(res.pages);
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND' || err?.status === 404) {
        setNoAudit(true);
        setPages([]);
      } else {
        report(err);
      }
    } finally {
      setPagesLoading(false);
    }
  }, [siteId, report]);

  useEffect(() => {
    loadPages();
  }, [loadPages]);

  const openPage = async (url: string) => {
    setSelectedUrl(url);
    setDetail(null);
    setDetailLoading(true);
    try {
      const res = await onpageApi.pageDetail(siteId, url);
      setDetail(res);
    } catch (err) {
      report(err);
    } finally {
      setDetailLoading(false);
    }
  };

  const analyzeManual = async (e: React.FormEvent) => {
    e.preventDefault();
    setManualLoading(true);
    setManualResult(null);
    try {
      const res = await onpageApi.analyze(siteId, manualUrl.trim());
      setManualResult(res);
    } catch (err) {
      report(err);
    } finally {
      setManualLoading(false);
    }
  };

  // ---- Detail view ----
  if (selectedUrl) {
    return (
      <div className="space-y-4">
        <button onClick={() => setSelectedUrl(null)} className="bx-btn-secondary text-xs">
          ← Back to pages
        </button>
        {detailLoading && <p className="text-sm text-white/55">Loading page analysis…</p>}
        {detail && (
          <>
            <div className="bx-card">
              <p className="bx-micro mb-1">~/ onpage detail</p>
              <h3 className="mb-3 break-all font-mono text-sm font-semibold text-white">
                {shortUrl(detail.url)}
              </h3>
              <div className="flex flex-wrap items-center gap-4">
                <div
                  className={`flex h-16 w-16 items-center justify-center rounded-full border font-mono text-2xl font-bold ${gradeColor(detail.grade)}`}
                >
                  {detail.grade}
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">
                    On-page score: <span className="font-mono">{detail.score}/100</span>
                  </p>
                  <p className="text-xs text-white/55">
                    Audit crawl se automatic analysis — neeche har check ki detail aur fix hai.
                  </p>
                </div>
              </div>
            </div>
            <div className="space-y-3">
              {detail.checks.map((c) => (
                <div key={c.key} className={`bx-card border ${STATUS_BORDER[c.status]}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">
                        {STATUS_ICON[c.status]} {c.label}
                      </p>
                      <p className="mt-1 text-xs text-white/60">{c.detail}</p>
                      {c.fix && (
                        <p className="mt-2 rounded bg-white/5 p-2 text-xs text-teal-200/90">
                          <strong>Fix:</strong> {c.fix}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 font-mono text-xs font-bold text-white/70">
                      {c.points}/{c.max}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  // ---- Main view: automatic page list ----
  return (
    <div className="space-y-6">
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ onpage</p>
        <h3 className="mb-1 text-sm font-semibold text-white">Pages from your latest audit</h3>
        <p className="text-xs text-white/55">
          Audit ne jo pages crawl kiye, unki on-page analysis automatic ready hai — koi URL
          paste karne ki zaroorat nahi. Kisi page pe click karo.
        </p>
        {!pagesLoading && pages && pages.length > 0 && (
          <button onClick={loadPages} className="bx-btn-secondary mt-2 text-xs">
            Refresh
          </button>
        )}
      </div>

      {pagesLoading && <p className="text-sm text-white/55">Loading crawled pages…</p>}

      {!pagesLoading && noAudit && (
        <div className="bx-card">
          <p className="text-sm text-white/70">
            Abhi tak koi finished audit nahi hai. Pehle <strong>Audit tab</strong> se audit
            chalao — uske baad yahan har page ki automatic analysis milegi.
          </p>
        </div>
      )}

      {!pagesLoading && !noAudit && pages && pages.length === 0 && (
        <div className="bx-card">
          <p className="text-sm text-white/70">Latest audit me koi pages nahi mile.</p>
        </div>
      )}

      {!pagesLoading && pages && pages.length > 0 && (
        <div className="bx-card">
          <p className="bx-micro mb-3">~/ {pages.length} pages</p>
          <div className="space-y-2">
            {pages.map((p) => (
              <button
                key={p.url}
                onClick={() => openPage(p.url)}
                className="bx-panel flex w-full items-center justify-between gap-3 text-left transition hover:border-white/20"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-white/85">{shortUrl(p.url)}</p>
                  <p className="truncate text-xs text-white/45">
                    {p.title || '(no title)'} · {p.word_count} words
                    {p.status_code !== 200 && ` · HTTP ${p.status_code}`}
                  </p>
                </div>
                <span
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border font-mono text-sm font-bold ${gradeColor(p.grade)}`}
                >
                  {p.grade}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ---- Secondary: manual single-page check (AI-powered) ---- */}
      <div className="bx-card">
        <button
          onClick={() => setShowManual((v) => !v)}
          className="flex w-full items-center justify-between text-left"
        >
          <div>
            <p className="bx-micro mb-1">~/ single page check</p>
            <h3 className="text-sm font-semibold text-white">Manual page check (optional)</h3>
            <p className="text-xs text-white/55">
              Koi specific URL jo audit me nahi hai? Yahan paste karke AI suggestions lo.
            </p>
          </div>
          <span className="text-white/50">{showManual ? '▲' : '▼'}</span>
        </button>

        {showManual && (
          <div className="mt-4">
            <form onSubmit={analyzeManual} className="flex flex-col gap-2 sm:flex-row">
              <input
                type="url"
                required
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                placeholder="https://example.com/blog/post"
                className="bx-input font-mono"
              />
              <button type="submit" disabled={manualLoading} className="bx-btn-primary shrink-0">
                {manualLoading ? 'Analyzing…' : 'Analyze'}
              </button>
            </form>
            <p className="bx-hint mt-2">
              Fetches the URL and returns AI-powered on-page optimization suggestions (uses AI budget).
            </p>

            {manualResult && (
              <div className="mt-4 space-y-4">
                <div className="bx-panel">
                  <div className="flex flex-wrap items-center gap-4">
                    <div
                      className={`flex h-16 w-16 items-center justify-center rounded-full border font-mono text-2xl font-bold ${gradeColor(manualResult.quality.grade)}`}
                    >
                      {manualResult.quality.grade}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-white">
                        Page quality score:{' '}
                        <span className="font-mono">{manualResult.quality.score}/100</span>
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {manualResult.quality.breakdown.map((b, i) => (
                      <div key={i} className="bx-panel flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold text-white/80">{b.label}</p>
                          <p className="text-xs text-white/55">{b.note}</p>
                        </div>
                        <span className="shrink-0 font-mono text-xs font-bold text-teal-300">
                          {b.points}/{b.max}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="bx-panel">
                  <p className="mb-3 text-sm font-semibold text-white">
                    Suggestions for{' '}
                    <span className="font-mono font-normal text-white/55">{manualResult.url}</span>
                  </p>
                  <div className="space-y-4">
                    {manualResult.suggestions.map((s, i) => (
                      <div key={i} className="bx-panel">
                        <p className="text-sm font-semibold text-teal-300">{s.area}</p>
                        {s.current && (
                          <p className="mt-1 text-xs text-white/55">
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
                    {manualResult.suggestions.length === 0 && (
                      <p className="text-sm text-white/55">No suggestions — this page looks good.</p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
