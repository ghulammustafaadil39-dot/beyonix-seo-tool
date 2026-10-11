// W-04: site-level Insights view — consumes the backend's
// GET /api/v1/sites/:id/insights (merged; typed adapter in lib/api.ts:
// insightsApi.get + normalizeInsightList, normalizeForecast,
// resolveInsightHref).
//
// Rendering: a labeled visibility PROJECTION card (estimated — never
// presented as measured traffic or a guarantee) above priority-sorted action
// cards: priority pill, title, detail, evidence (string/list/label-value),
// and a deep link to the relevant tab.
// Honest when the endpoint 404s: shows "not available yet" instead of
// fabricated data — nothing is ever mocked. (Last resort now that the
// endpoint is merged; it should rarely trigger.)
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  insightsApi,
  insightPriorityLabel,
  insightPriorityRank,
  resolveInsightHref,
  ApiError,
  type SiteForecast,
  type SiteInsight,
} from '@/lib/api';
import { useErrorReporter } from '../ErrorBanner';
import { PageHeaderSkeleton, SkeletonLines } from '../Skeleton';

function Evidence({ evidence }: { evidence: unknown }) {
  if (evidence == null) return null;
  if (typeof evidence === 'string') {
    return <p className="mt-2 text-xs text-white/60">{evidence}</p>;
  }
  if (Array.isArray(evidence)) {
    if (evidence.length === 0) return null;
    return (
      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-white/60">
        {evidence.map((e, i) => (
          <li key={i}>
            {typeof e === 'string' ? e : <code className="font-mono">{JSON.stringify(e)}</code>}
          </li>
        ))}
      </ul>
    );
  }
  if (typeof evidence === 'object') {
    const entries = Object.entries(evidence as Record<string, unknown>);
    if (entries.length === 0) return null;
    return (
      <dl className="mt-2 space-y-1">
        {entries.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 text-xs">
            <dt className="text-white/55">{k.replace(/_/g, ' ')}</dt>
            <dd className="font-mono text-right text-white/70">
              {typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v)}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return null;
}

const PRIORITY_PILL: Record<string, string> = {
  Critical: 'bx-pill-err',
  High: 'bx-pill-warn',
  Medium: 'bx-pill-sky',
  Low: 'bx-pill-info',
};

export default function InsightsTab({ siteId }: { siteId: string }) {
  const { report } = useErrorReporter();
  const [insights, setInsights] = useState<SiteInsight[] | null>(null);
  const [forecast, setForecast] = useState<SiteForecast | null>(null);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    setInsights(null);
    setForecast(null);
    setComputedAt(null);
    setUnavailable(false);
    try {
      const res = await insightsApi.get(siteId);
      setInsights(res.insights);
      setForecast(res.forecast);
      setComputedAt(res.computedAt);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // Backend didn't return insights for this site — say so honestly,
        // no fake data. Last resort now that the endpoint is merged.
        setUnavailable(true);
      } else {
        report(e);
      }
      setInsights([]);
    }
  }, [siteId, report]);

  useEffect(() => {
    load();
  }, [load]);

  if (insights === null) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading insights">
        <PageHeaderSkeleton />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bx-card">
            <SkeletonLines rows={3} />
          </div>
        ))}
      </div>
    );
  }

  if (unavailable) {
    return (
      <div className="bx-empty">
        <p className="text-sm font-medium text-white">Insights aren&apos;t available yet</p>
        <p className="mt-1 text-sm text-white/50">
          The backend didn&apos;t return insights for this site yet — this view will show
          prioritized actions and a visibility projection as soon as they&apos;re ready.
        </p>
      </div>
    );
  }

  if (insights.length === 0 && !forecast) {
    return (
      <div className="bx-empty">
        <p className="text-sm font-medium text-white">Nothing to do right now</p>
        <p className="mt-1 text-sm text-white/50">
          No prioritized actions for this site. Run an audit or keyword research and check back.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {forecast && <ForecastCard forecast={forecast} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="bx-micro mb-1">~/ do this next</p>
          <h2 className="bx-h2">Prioritized actions</h2>
          {computedAt && (
            <p className="mt-1 font-mono text-[11px] text-white/40">
              computed {new Date(computedAt).toLocaleString()}
            </p>
          )}
        </div>
        <button onClick={load} className="bx-btn-secondary !px-3 !py-1.5 !text-xs">
          Refresh
        </button>
      </div>

      {insights.length === 0 ? (
        <div className="bx-empty">
          <p className="text-sm font-medium text-white">Nothing to do right now</p>
          <p className="mt-1 text-sm text-white/50">
            No prioritized actions for this site. Run an audit or keyword research and check back.
          </p>
        </div>
      ) : (
      <ol className="space-y-3">
        {insights.map((ins, i) => {
          const label = insightPriorityLabel(ins.priority);
          const rank = insightPriorityRank(ins.priority);
          return (
            <li key={ins.id ?? `${ins.type}-${i}`} className="bx-card">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="font-mono text-lg font-bold text-teal-300/60"
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-white">{ins.title}</p>
                    <p className="font-mono text-[11px] uppercase tracking-wider text-white/50">
                      {ins.type.replace(/_/g, ' ')}
                      {typeof ins.impact === 'number' && ` · impact ${ins.impact}`}
                    </p>
                  </div>
                </div>
                <span className={`bx-pill ${PRIORITY_PILL[label] ?? 'bx-pill-info'}`} aria-label={`Priority ${label}`}>
                  <span className="bx-dot" />
                  {label}
                  {typeof ins.priority === 'number' && (
                    <span className="sr-only"> (score {rank})</span>
                  )}
                </span>
              </div>
              {ins.detail && <p className="mt-2 text-sm text-white/60">{ins.detail}</p>}
              <Evidence evidence={ins.evidence} />
              <Link
                href={resolveInsightHref(siteId, ins.target, ins.type)}
                className="bx-link mt-3 inline-block text-xs"
              >
                Open in context →
              </Link>
            </li>
          );
        })}
      </ol>
      )}
    </div>
  );
}

/**
 * Visibility PROJECTION card. Labeled as an estimate everywhere it appears:
 * the numbers are a linear-trend projection over the rank-visibility index,
 * never measured traffic and never a promise.
 */
function ForecastCard({ forecast }: { forecast: SiteForecast }) {
  const delta = forecast.visibilityIndexProjected - forecast.visibilityIndexNow;
  const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`;
  return (
    <section className="bx-card" aria-label="Visibility projection (estimated)">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="bx-micro mb-1">~/ projection — estimated, not measured</p>
          <h2 className="bx-h2">Visibility projection</h2>
        </div>
        <span
          className="bx-pill bx-pill-info"
          title="Computed estimate from rank trends — not a promise"
        >
          <span className="bx-dot" />
          projection
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-1">
        <p className="font-mono text-3xl text-white">
          {forecast.visibilityIndexNow.toFixed(1)}
        </p>
        <p aria-hidden="true" className="pb-1 text-xl text-white/40">
          →
        </p>
        <p className="font-mono text-3xl text-teal-300">
          {forecast.visibilityIndexProjected.toFixed(1)}
        </p>
        <p className="pb-1 text-xs text-white/50">
          visibility index · +{forecast.horizonDays}d{' '}
          <span className={delta >= 0 ? 'text-teal-300' : 'text-red-300'}>
            ({deltaStr})
          </span>
        </p>
      </div>

      <p className="mt-2 text-xs text-white/60">{forecast.label}</p>
      <p className="mt-1 font-mono text-[11px] text-white/40">
        based on {forecast.basedOnDays} days of tracked rank data
        {forecast.method ? ` · ${forecast.method}` : ''}
      </p>
      <p className="mt-2 text-[11px] font-medium text-amber-200/80">
        A projection, not a promise — estimated from rank trends, never measured traffic.
      </p>
    </section>
  );
}
