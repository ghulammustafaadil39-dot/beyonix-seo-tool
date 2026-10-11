// W-04: site-level Insights view — consumes the backend's
// GET /api/v1/sites/:id/insights (contract lands in parallel; this UI is
// built against the typed adapter in lib/api.ts: insightsApi.list +
// normalizeInsightList, resolveInsightHref).
//
// Rendering is priority-sorted action cards: priority pill, title, detail,
// evidence (string/list/label-value), and a deep link to the relevant tab.
// Honest when the endpoint isn't there yet: a 404 shows "not available yet"
// instead of fabricated data — nothing is ever mocked.
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  insightsApi,
  insightPriorityLabel,
  insightPriorityRank,
  resolveInsightHref,
  ApiError,
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
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    setInsights(null);
    setUnavailable(false);
    try {
      setInsights(await insightsApi.list(siteId));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // Backend not merged yet — say so honestly, no fake data.
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
          The Insights engine is rolling out — this view will show prioritized actions here as soon
          as the backend endpoint lands.
        </p>
      </div>
    );
  }

  if (insights.length === 0) {
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="bx-micro mb-1">~/ do this next</p>
          <h2 className="bx-h2">Prioritized actions</h2>
        </div>
        <button onClick={load} className="bx-btn-secondary !px-3 !py-1.5 !text-xs">
          Refresh
        </button>
      </div>

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
    </div>
  );
}
