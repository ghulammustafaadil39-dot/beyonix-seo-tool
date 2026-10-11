'use client';

import { useEffect, useState } from 'react';
import { auditsApi, type Audit, type AuditIssue } from '@/lib/api';
import { useErrorReporter } from '../ErrorBanner';
import ScoreGauge from '../ScoreGauge';
import JobProgress from '../JobProgress';
import { useJobStream } from '@/lib/useJobStream';
import { auditPoll } from '@/lib/jobPoll';
import { PageHeaderSkeleton, TableSkeleton } from '../Skeleton';
import dynamic from 'next/dynamic';
const AuditV2Panel = dynamic(() => import('./AuditV2Panel').then((m) => m.default), {
  loading: () => <div role="status" aria-label="Loading advanced panel" className="bx-panel"><div className="bx-shimmer h-24 rounded-md bg-white/5" aria-hidden="true" /></div>,
  ssr: false,
});

const SEVERITY_COLOR: Record<string, string> = {
  error: 'bx-pill-err',
  warning: 'bx-pill-warn',
  info: 'bx-pill-info',
};

export default function AuditTab({ siteId }: { siteId: string }) {
  const { report } = useErrorReporter();
  const [audits, setAudits] = useState<Audit[]>([]);
  const [selected, setSelected] = useState<Audit | null>(null);
  const [issues, setIssues] = useState<AuditIssue[]>([]);
  const [severity, setSeverity] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);

  const loadAudits = async () => {
    try {
      const res = await auditsApi.list(siteId);
      setAudits(res.data);
      if (!selected && res.data.length > 0) setSelected(res.data[0]);
      else if (selected) {
        const fresh = res.data.find((a) => a.id === selected.id);
        if (fresh) setSelected(fresh);
      }
    } catch (e) {
      report(e);
    } finally {
      setLoading(false);
    }
  };

  const loadIssues = async () => {
    if (!selected) {
      setIssues([]);
      return;
    }
    try {
      const res = await auditsApi.issues(selected.id, {
        severity: severity || undefined,
        status: statusFilter || undefined,
      });
      setIssues(res.data);
    } catch (e) {
      report(e);
    }
  };

  useEffect(() => {
    loadAudits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  useEffect(() => {
    loadIssues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, severity, statusFilter]);

  // W-05: live progress while an audit is queued/running — prefers the
  // SSE stream, falls back to polling the audits list.
  const watchActive = selected !== null && (selected.status === 'queued' || selected.status === 'running');
  const { event: jobEvent, mode: jobMode } = useJobStream({
    siteId,
    enabled: watchActive,
    poll: () => auditPoll(siteId),
    onTerminal: () => {
      loadAudits();
    },
  });

  const startAudit = async () => {
    setStarting(true);
    try {
      const a = await auditsApi.start(siteId);
      setAudits((prev) => [a, ...prev]);
      setSelected(a);
    } catch (e) {
      report(e);
    } finally {
      setStarting(false);
    }
  };

  // W-05: optimistic UI — the select updates immediately (cheap,
  // reversible mutation) and rolls back to the previous value on error.
  const setIssueStatus = async (issueId: string, status: 'open' | 'ignored' | 'resolved' | 'wont-fix') => {
    const prev = issues;
    setIssues((cur) => cur.map((i) => (i.id === issueId ? { ...i, status } : i)));
    try {
      const updated = await auditsApi.setIssueStatus(issueId, status);
      setIssues((cur) => cur.map((i) => (i.id === issueId ? updated : i)));
    } catch (e) {
      setIssues(prev); // rollback
      report(e);
    }
  };

  if (loading)
    return (
      <div className="space-y-4">
        <PageHeaderSkeleton />
        <TableSkeleton rows={6} cols={5} />
      </div>
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <select
            value={selected?.id ?? ''}
            onChange={(e) =>
              setSelected(audits.find((a) => a.id === e.target.value) ?? null)
            }
            className="bx-input !w-auto"
            aria-label="Choose audit"
          >
            {audits.map((a) => (
              <option key={a.id} value={a.id}>
                {a.finished_at
                  ? new Date(a.finished_at).toLocaleString()
                  : `${a.status} (in progress)`}
              </option>
            ))}
            {audits.length === 0 && <option value="">No audits yet</option>}
          </select>
          <button
            onClick={startAudit}
            disabled={starting}
            className="bx-btn-primary"
          >
            {starting ? 'Starting…' : 'Run audit'}
          </button>
        </div>
        {selected && (
          <span className="font-mono text-xs text-white/55">
            status: <strong className="text-teal-300">{selected.status}</strong> · pages crawled:{' '}
            {selected.pages_crawled} · issues: {selected.issues_count}
          </span>
        )}
      </div>

      {watchActive && jobEvent && <JobProgress event={jobEvent} mode={jobMode} />}

      {selected && (
        <div className="bx-card bx-glow">
          <div className="relative">
            <p className="bx-micro mb-3">~/ health score</p>
            <ScoreGauge score={selected.score} label="Health score" />
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className="bx-input !w-auto"
          aria-label="Filter by severity"
        >
          <option value="">All severities</option>
          <option value="error">Error</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bx-input !w-auto"
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="ignored">Ignored</option>
          <option value="wont-fix">Won't fix</option>
        </select>
      </div>

      <div className="bx-table-wrap">
        <table className="min-w-full">
          <thead className="border-b border-white/10 bg-white/[0.03]">
            <tr>
              <th className="bx-th">Severity</th>
              <th className="bx-th">Issue</th>
              <th className="bx-th">URL</th>
              <th className="bx-th">Fix</th>
              <th className="bx-th">Status</th>
            </tr>
          </thead>
          <tbody className="bx-tbody">
            {issues.map((i) => (
              <tr key={i.id} className="transition hover:bg-white/[0.02]">
                <td className="px-4 py-3">
                  <span className={`bx-pill ${SEVERITY_COLOR[i.severity] ?? 'bx-pill-info'}`}>
                    <span className="bx-dot" />
                    {i.severity}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <p className="text-sm font-medium text-white">{i.type}</p>
                  <p className="text-xs text-white/55">{i.detail}</p>
                </td>
                <td className="max-w-[220px] truncate px-4 py-3 font-mono text-xs text-white/55">{i.url}</td>
                <td className="max-w-[260px] px-4 py-3 text-xs text-white/60">{i.fix_suggestion}</td>
                <td className="px-4 py-3">
                  <select
                    value={i.status}
                    onChange={(e) =>
                      setIssueStatus(i.id, e.target.value as 'open' | 'ignored' | 'resolved' | 'wont-fix')
                    }
                    className="bx-input !w-auto !px-2 !py-1 !text-xs"
                    aria-label={`Status for issue ${i.type}`}
                  >
                    <option value="open">Open</option>
                    <option value="resolved">Resolved</option>
                    <option value="ignored">Ignored</option>
                    <option value="wont-fix">Won't fix</option>
                  </select>
                </td>
              </tr>
            ))}
            {issues.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-white/55">
                  {selected ? 'No issues match the filters.' : 'Run an audit to see issues.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <AuditV2Panel siteId={siteId} issues={issues} audits={audits} />
    </div>
  );
}
