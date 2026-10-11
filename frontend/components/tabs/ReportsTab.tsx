'use client';

import { useEffect, useRef, useState } from 'react';
import { reportsApi, type Report } from '@/lib/api';
import { useErrorReporter } from '../ErrorBanner';
import JobProgress from '../JobProgress';
import { useJobStream } from '@/lib/useJobStream';
import { reportPoll } from '@/lib/jobPoll';
import { SkeletonLines } from '../Skeleton';
import dynamic from 'next/dynamic';
const ReportsV2Panel = dynamic(() => import('./ReportsV2Panel').then((m) => m.default), {
  loading: () => <div role="status" aria-label="Loading advanced panel" className="bx-panel"><div className="bx-shimmer h-24 rounded-md bg-white/5" aria-hidden="true" /></div>,
  ssr: false,
});

interface Highlights {
  auditScore?: number | null;
  openIssues?: { error?: number; warning?: number; info?: number };
  rankMoves?: Array<{ keyword: string; from: number | null; to: number | null }>;
  newBacklinks?: number;
  lostBacklinks?: number;
  geoScore?: number;
  draftsInReview?: number;
}

/** Renders report highlights as a plain-language list (never raw JSON). */
function HighlightList({ highlights }: { highlights: Record<string, unknown> }) {
  const h = highlights as unknown as Highlights;
  const rows: Array<[string, string]> = [];
  if (h.auditScore != null) rows.push(['Site health score', `${h.auditScore} / 100`]);
  if (h.openIssues)
    rows.push([
      'Open issues',
      `${h.openIssues.error ?? 0} errors, ${h.openIssues.warning ?? 0} warnings, ${h.openIssues.info ?? 0} info`,
    ]);
  if (typeof h.geoScore === 'number') rows.push(['AI visibility score', `${h.geoScore}% of AI answers mentioned your brand`]);
  rows.push(['Backlinks', `${h.newBacklinks ?? 0} new, ${h.lostBacklinks ?? 0} lost`]);
  if (typeof h.draftsInReview === 'number' && h.draftsInReview > 0)
    rows.push(['Content drafts awaiting review', String(h.draftsInReview)]);
  const moves = (h.rankMoves ?? []).filter((m) => m.from != null && m.to != null && m.from !== m.to).slice(0, 5);
  if (rows.length === 0 && moves.length === 0) return null;
  return (
    <div className="bx-panel mt-3">
      <p className="bx-micro mb-2">~/ key numbers</p>
      <dl className="space-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 text-sm">
            <dt className="text-white/60">{k}</dt>
            <dd className="font-mono font-medium text-white">{v}</dd>
          </div>
        ))}
      </dl>
      {moves.length > 0 && (
        <div className="mt-2 border-t border-white/10 pt-2">
          <p className="bx-micro mb-1">~/ biggest rank moves</p>
          <ul className="space-y-1 text-sm">
            {moves.map((m, i) => (
              <li key={i} className="flex justify-between gap-4">
                <span className="text-white/70">{m.keyword}</span>
                <span className={`font-mono font-medium ${m.to! < m.from! ? 'text-teal-300' : 'text-red-300'}`}>
                  {m.from} → {m.to}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function ReportsTab({ siteId }: { siteId: string }) {
  const { report } = useErrorReporter();
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = async () => {
    try {
      const res = await reportsApi.list(siteId);
      setReports(res.data);
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

  const [watchReports, setWatchReports] = useState(false);
  const [reportBaseline, setReportBaseline] = useState(0);
  const reportSettled = useRef(false);

  // W-05: live progress for report generation — SSE stream first,
  // polling fallback watches for a new report to land.
  const { event: jobEvent, mode: jobMode, reset: resetJob } = useJobStream({
    siteId,
    enabled: watchReports,
    poll: reportPoll(siteId, reportBaseline),
    onTerminal: () => {
      reportSettled.current = true;
      setWatchReports(false);
      setGenerating(false);
      load();
    },
  });

  const generate = async () => {
    setGenerating(true);
    try {
      const before = reports.length;
      setReportBaseline(before);
      await reportsApi.generate(siteId);
      reportSettled.current = false;
      setWatchReports(true);
      resetJob();
      // Safety net: if no stream event arrives within 60s, reload anyway.
      setTimeout(() => {
        if (!reportSettled.current) {
          reportSettled.current = true;
          setWatchReports(false);
          setGenerating(false);
          load();
        }
      }, 60000);
    } catch (e) {
      report(e);
      setWatchReports(false);
      setGenerating(false);
    }
  };

  if (loading)
    return (
      <div className="space-y-3" role="status" aria-label="Loading reports">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bx-card">
            <SkeletonLines rows={2} />
          </div>
        ))}
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="font-mono text-sm text-white/55">{reports.length} reports</p>
        <button
          onClick={generate}
          disabled={generating}
          className="bx-btn-primary"
        >
          {generating ? 'Generating…' : 'Generate report'}
        </button>
      </div>

      {watchReports && jobEvent && <JobProgress event={jobEvent} mode={jobMode} compact />}
      {watchReports && !jobEvent && (
        <p className="font-mono text-xs text-white/55" role="status">
          $ building report — this list will refresh automatically…
        </p>
      )}

      <div className="space-y-3">
        {reports.map((r) => (
          <div key={r.id} className="bx-card">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-white">
                  {new Date(r.period_start).toLocaleDateString()} —{' '}
                  {new Date(r.period_end).toLocaleDateString()}
                </p>
                <p className="font-mono text-xs text-white/50">
                  created {new Date(r.created_at).toLocaleString()}
                </p>
              </div>
              <button
                onClick={() => setOpen((prev) => ({ ...prev, [r.id]: !prev[r.id] }))}
                className="bx-btn-secondary !px-3 !py-1.5 !text-xs"
              >
                {open[r.id] ? 'Hide summary' : 'View summary'}
              </button>
            </div>
            {open[r.id] && (
              <div className="mt-3 border-t border-white/10 pt-3">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/70">{r.summary}</p>
                {r.highlights && <HighlightList highlights={r.highlights} />}
              </div>
            )}
          </div>
        ))}
        {reports.length === 0 && (
          <div className="bx-empty">
            <p className="text-sm text-white/55">No reports yet — generate your first one above.</p>
          </div>
        )}
      </div>

      <ReportsV2Panel siteId={siteId} />
    </div>
  );
}
