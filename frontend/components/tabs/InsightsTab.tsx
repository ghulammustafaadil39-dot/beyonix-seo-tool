// Phase 6: Insights dashboard overhaul.
//
// Unified view: health score hero, "is hafte" (weekly summary), progress
// (week-over-week + keyword movers), "agla kadam" (action items), plus the
// existing prioritized actions engine. Every metric carries a plain-language
// explanation — no bare zeros. Beginner-friendly throughout.
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  insightsApi,
  reportsApi,
  insightPriorityLabel,
  insightPriorityRank,
  resolveInsightHref,
  ApiError,
  type SiteForecast,
  type SiteInsight,
  type InsightsDashboard,
  type WeeklyReport,
} from '@/lib/api';
import { useErrorReporter } from '../ErrorBanner';
import { PageHeaderSkeleton, SkeletonLines } from '../Skeleton';

const GRADE_STYLE: Record<string, { ring: string; text: string; label: string }> = {
  excellent: { ring: 'border-teal-400/40', text: 'text-teal-300', label: 'Excellent' },
  good: { ring: 'border-sky-400/40', text: 'text-sky-300', label: 'Good' },
  needs_work: { ring: 'border-amber-400/40', text: 'text-amber-300', label: 'Needs work' },
  critical: { ring: 'border-red-400/40', text: 'text-red-300', label: 'Critical' },
  unknown: { ring: 'border-white/15', text: 'text-white/50', label: 'Not yet measured' },
};

function HealthHero({ dashboard, siteId }: { dashboard: InsightsDashboard; siteId: string }) {
  const h = dashboard.health;
  const g = GRADE_STYLE[h.grade] ?? GRADE_STYLE.unknown;
  return (
    <section className={`bx-card border ${g.ring}`} aria-label="Site health">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="bx-micro mb-1">~/ site health</p>
          <div className="flex items-baseline gap-3">
            <span className={`font-mono text-5xl font-bold ${g.text}`}>
              {h.score != null ? h.score : '—'}
            </span>
            <span className="text-sm text-white/50">/ 100</span>
            <span className={`bx-pill ${g.text}`}>
              <span className="bx-dot" />
              {g.label}
            </span>
          </div>
          <p className="mt-2 max-w-xl text-sm text-white/60">{h.summary}</p>
          {h.lastAuditAt && (
            <p className="mt-1 font-mono text-[11px] text-white/40">
              last audit {new Date(h.lastAuditAt).toLocaleString()}
            </p>
          )}
        </div>
        <Link href={`/dashboard/sites/${siteId}/audit`} className="bx-btn-secondary !px-3 !py-1.5 !text-xs">
          Open audit →
        </Link>
      </div>
    </section>
  );
}

function MetricCard({
  title,
  value,
  summary,
  href,
  linkLabel,
}: {
  title: string;
  value: string;
  summary: string;
  href?: string;
  linkLabel?: string;
}) {
  return (
    <div className="bx-card">
      <p className="bx-micro mb-1">{title}</p>
      <p className="font-mono text-2xl text-white">{value}</p>
      <p className="mt-1 text-xs text-white/55">{summary}</p>
      {href && linkLabel && (
        <Link href={href} className="bx-link mt-2 inline-block text-xs">
          {linkLabel} →
        </Link>
      )}
    </div>
  );
}

function WeeklySection({
  report,
  siteId,
  onShare,
  sharing,
}: {
  report: WeeklyReport | null;
  siteId: string;
  onShare: () => void;
  sharing: boolean;
}) {
  if (!report) return null;
  const sections = [report.whatHappened, report.whatImproved, report.nextSteps];
  return (
    <section className="bx-card" aria-label="Weekly report">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="bx-micro mb-1">~/ is hafte ki report</p>
          <h2 className="bx-h2">Weekly report</h2>
          <p className="mt-1 font-mono text-[11px] text-white/40">
            {new Date(report.periodStart).toLocaleDateString()} –{' '}
            {new Date(report.periodEnd).toLocaleDateString()}
          </p>
        </div>
        <button onClick={onShare} disabled={sharing} className="bx-btn-secondary !px-3 !py-1.5 !text-xs">
          {sharing ? 'Sharing…' : 'Share report'}
        </button>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        {sections.map((s) => (
          <div key={s.heading}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/70">
              {s.heading}
            </p>
            <ul className="space-y-1.5">
              {s.items.map((item, i) => (
                <li key={i} className="text-xs text-white/60">
                  • {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function InsightsTab({ siteId }: { siteId: string }) {
  const { report } = useErrorReporter();
  const [dashboard, setDashboard] = useState<InsightsDashboard | null>(null);
  const [weekly, setWeekly] = useState<WeeklyReport | null>(null);
  const [insights, setInsights] = useState<SiteInsight[] | null>(null);
  const [forecast, setForecast] = useState<SiteForecast | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    setDashboard(null);
    setWeekly(null);
    setInsights(null);
    try {
      const [dash, wk, ins] = await Promise.all([
        insightsApi.dashboard(siteId),
        insightsApi.weekly(siteId).catch(() => null),
        insightsApi.get(siteId).catch(() => null),
      ]);
      setDashboard(dash);
      setWeekly(wk);
      if (ins) {
        setInsights(ins.insights);
        setForecast(ins.forecast);
      } else {
        setInsights([]);
      }
    } catch (e) {
      report(e);
      setDashboard(null);
      setInsights([]);
    }
  }, [siteId, report]);

  useEffect(() => {
    load();
  }, [load]);

  const handleShare = useCallback(async () => {
    setSharing(true);
    setShareUrl(null);
    try {
      // Generate a stored weekly report, then share it.
      const { report: stored } = await reportsApi.generateWeekly(siteId);
      const { url } = await reportsApi.share(stored.id);
      setShareUrl(url);
    } catch (e) {
      report(e);
    } finally {
      setSharing(false);
    }
  }, [siteId, report]);

  const handleGenerateWeekly = useCallback(async () => {
    setGenerating(true);
    try {
      await reportsApi.generateWeekly(siteId);
      const wk = await insightsApi.weekly(siteId).catch(() => null);
      setWeekly(wk);
    } catch (e) {
      report(e);
    } finally {
      setGenerating(false);
    }
  }, [siteId, report]);

  if (dashboard === null) {
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

  const d = dashboard;
  return (
    <div className="space-y-6">
      <HealthHero dashboard={d} siteId={siteId} />

      {/* Metric grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          title="keywords tracked"
          value={String(d.keywords.tracked)}
          summary={d.keywords.summary}
          href={`/dashboard/sites/${siteId}/keywords`}
          linkLabel="Keywords"
        />
        <MetricCard
          title="content"
          value={`${d.content.publishedMonth}/mo`}
          summary={d.content.summary}
          href={`/dashboard/sites/${siteId}/content`}
          linkLabel="Content"
        />
        <MetricCard
          title="backlinks won"
          value={String(d.backlinks.won)}
          summary={d.backlinks.summary}
          href={`/dashboard/sites/${siteId}/backlinks`}
          linkLabel="Backlinks"
        />
        <MetricCard
          title="ai-readiness"
          value={d.geo.score != null ? `${d.geo.score}/100` : '—'}
          summary={d.geo.summary}
          href={`/dashboard/sites/${siteId}/geo`}
          linkLabel="GEO"
        />
        <MetricCard
          title="competitors"
          value={String(d.competitors.total)}
          summary={d.competitors.summary}
          href={`/dashboard/sites/${siteId}/competitors`}
          linkLabel="Competitors"
        />
        <MetricCard
          title="week over week"
          value={
            d.weekOverWeek.scoreChange != null
              ? `${d.weekOverWeek.scoreChange > 0 ? '+' : ''}${d.weekOverWeek.scoreChange}`
              : '—'
          }
          summary={d.weekOverWeek.summary}
          href={`/dashboard/sites/${siteId}/audit`}
          linkLabel="Audit"
        />
      </div>

      {/* Keyword movers */}
      {(d.keywords.topGainers.length > 0 || d.keywords.topLosers.length > 0) && (
        <section className="bx-card" aria-label="Keyword movements">
          <p className="bx-micro mb-1">~/ ranking movements</p>
          <h2 className="bx-h2 mb-3">Keyword movers</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {d.keywords.topGainers.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold text-teal-300">▲ Climbing</p>
                <ul className="space-y-1">
                  {d.keywords.topGainers.map((g) => (
                    <li key={g.keyword} className="font-mono text-xs text-white/60">
                      {g.keyword} <span className="text-teal-300">{g.from} → {g.to}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {d.keywords.topLosers.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold text-red-300">▼ Dropping</p>
                <ul className="space-y-1">
                  {d.keywords.topLosers.map((l) => (
                    <li key={l.keyword} className="font-mono text-xs text-white/60">
                      {l.keyword} <span className="text-red-300">{l.from} → {l.to}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Weekly report */}
      {weekly ? (
        <WeeklySection report={weekly} siteId={siteId} onShare={handleShare} sharing={sharing} />
      ) : (
        <section className="bx-card">
          <p className="bx-micro mb-1">~/ weekly report</p>
          <p className="text-sm text-white/60">No weekly report yet.</p>
          <button
            onClick={handleGenerateWeekly}
            disabled={generating}
            className="bx-btn-secondary mt-2 !px-3 !py-1.5 !text-xs"
          >
            {generating ? 'Generating…' : 'Generate weekly report'}
          </button>
        </section>
      )}
      {shareUrl && (
        <div className="bx-card border-teal-400/30">
          <p className="text-xs text-white/70">Shareable link (anyone with this link can view):</p>
          <p className="mt-1 break-all font-mono text-xs text-teal-300">{shareUrl}</p>
        </div>
      )}

      {/* Prioritized actions (existing engine) */}
      {insights && insights.length > 0 && (
        <section aria-label="Prioritized actions">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="bx-micro mb-1">~/ agla kadam</p>
              <h2 className="bx-h2">Prioritized actions</h2>
            </div>
            <button onClick={load} className="bx-btn-secondary !px-3 !py-1.5 !text-xs">
              Refresh
            </button>
          </div>
          <ol className="space-y-3">
            {insights.slice(0, 5).map((ins, i) => {
              const label = insightPriorityLabel(ins.priority);
              return (
                <li key={ins.id ?? `${ins.type}-${i}`} className="bx-card">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-white">{ins.title}</p>
                      {ins.detail && <p className="mt-1 text-xs text-white/60">{ins.detail}</p>}
                    </div>
                    <span className="bx-pill bx-pill-info shrink-0">
                      <span className="bx-dot" />
                      {label}
                    </span>
                  </div>
                  <Link
                    href={resolveInsightHref(siteId, ins.target, ins.type)}
                    className="bx-link mt-2 inline-block text-xs"
                  >
                    Open in context →
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
