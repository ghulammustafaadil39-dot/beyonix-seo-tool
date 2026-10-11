'use client';

import { useEffect, useState } from 'react';
import type { Audit, AuditIssue } from '@/lib/api';
import { withMockFallback, notLandedYet } from '@/lib/mock';
import { mockAuditHistory, mockShareLink, groupIssues, type AuditHistoryPoint } from '@/lib/mock/audit';
import { downloadTextFile } from '@/lib/mock/backlinks';
import MockBanner from '@/components/MockBanner';

/**
 * F-02 — Audit v2 UI extras. Grouped fixes + CSV export work on REAL
 * issue data (client-side). Change history and shareable links are
 * mock-backed until their endpoints land (bannered).
 */
export default function AuditV2Panel({
  siteId,
  issues,
  audits,
}: {
  siteId: string;
  issues: AuditIssue[];
  audits: Audit[];
}) {
  const [history, setHistory] = useState<AuditHistoryPoint[] | null>(null);
  const [historyMock, setHistoryMock] = useState(false);
  const [grouped, setGrouped] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareMock, setShareMock] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      const { data, mock } = await withMockFallback(
        () => notLandedYet<AuditHistoryPoint[]>(),
        mockAuditHistory,
      );
      setHistory(data);
      setHistoryMock(mock);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  const createShareLink = async () => {
    setShareBusy(true);
    try {
      const { data, mock } = await withMockFallback(
        () => notLandedYet<{ share_url: string }>(),
        () => mockShareLink(siteId),
      );
      setShareUrl(data.share_url);
      setShareMock(mock);
    } finally {
      setShareBusy(false);
    }
  };

  const exportCsv = () => {
    const rows = [
      ['severity', 'issue', 'url', 'status', 'fix'].join(','),
      ...issues.map((i) =>
        [i.severity, i.type, i.url, i.status, i.fix_suggestion]
          .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
          .join(','),
      ),
    ];
    downloadTextFile(`audit-issues-${siteId}.csv`, rows.join('\n'));
  };

  const groups = grouped ? groupIssues(issues) : null;
  const scoreDelta =
    history && history.length >= 2
      ? (history[history.length - 1].score ?? 0) - (history[history.length - 2].score ?? 0)
      : null;

  return (
    <div className="space-y-6">
      {/* Grouped fixes + CSV */}
      <div className="bx-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="bx-micro mb-1">~/ fix planning</p>
            <h3 className="text-base font-bold text-white">Grouped fixes</h3>
            <p className="bx-body mt-1">
              Group issues by type to fix whole categories at once.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setGrouped((v) => !v)}
              className="bx-btn-secondary !text-xs"
              aria-pressed={grouped}
            >
              {grouped ? 'Ungroup' : 'Group by issue type'}
            </button>
            <button onClick={exportCsv} className="bx-btn-secondary !text-xs" disabled={issues.length === 0}>
              Export CSV
            </button>
            <button onClick={createShareLink} disabled={shareBusy} className="bx-btn-secondary !text-xs">
              {shareBusy ? 'Creating…' : 'Shareable link'}
            </button>
          </div>
        </div>
        {shareUrl && (
          <div className="mt-3">
            {shareMock && <div className="mb-2"><MockBanner label="shareable link" /></div>}
            <div className="flex items-center gap-2">
              <input readOnly value={shareUrl} className="bx-input font-mono !text-xs" aria-label="Shareable audit link" />
              <button
                onClick={() => {
                  navigator.clipboard.writeText(shareUrl).catch(() => {});
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="bx-btn-xs-secondary"
              >
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
          </div>
        )}
        {groups && (
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {groups.map((g) => (
              <div key={g.type} className="bx-panel flex items-center justify-between">
                <span className="text-sm font-medium text-white">{g.type}</span>
                <span className="bx-pill bx-pill-info">
                  <span className="bx-dot" />
                  {g.items.length} page{g.items.length === 1 ? '' : 's'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Change history */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ history</p>
        <h3 className="text-base font-bold text-white">Score history</h3>
        {historyMock && (
          <div className="mt-2 mb-3">
            <MockBanner label="audit history" />
          </div>
        )}
        {history && history.length > 0 ? (
          <div>
            <div className="flex items-end gap-1" role="img" aria-label="Health score history chart">
              {history.map((h) => (
                <div key={h.audit_id} className="flex-1" title={`${new Date(h.finished_at).toLocaleDateString()}: ${h.score}/100, ${h.issues_count} issues`}>
                  <div
                    className="w-full rounded-t bg-gradient-to-t from-teal-500/60 to-cyan-300/80"
                    style={{ height: `${Math.max(8, (h.score ?? 0) * 1.6)}px` }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-2 flex justify-between font-mono text-[11px] text-white/40">
              <span>{new Date(history[0].finished_at).toLocaleDateString()}</span>
              <span>
                latest: <strong className="text-teal-300">{history[history.length - 1].score}/100</strong>
                {scoreDelta !== null && scoreDelta !== 0 && (
                  <span className={scoreDelta > 0 ? 'text-teal-300' : 'text-red-300'}>
                    {' '}({scoreDelta > 0 ? '+' : ''}{scoreDelta} vs previous)
                  </span>
                )}
              </span>
            </div>
          </div>
        ) : (
          <p className="text-sm text-white/40">No audit history yet.</p>
        )}
      </div>
    </div>
  );
}
