'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  auditsV2Api,
  type Audit,
  type AuditDiff,
  type AuditGroup,
  type AuditIssue,
  type ShareLink,
} from '@/lib/api';

/**
 * F-02 — Audit v2 (WIRED, Wave 2 round 2): server-grouped fixes, change
 * history (audit list + per-audit diff), and share create/list/revoke
 * against the real Backend-B endpoints. Issue states follow the backend
 * enum: open | ignored | resolved | wont-fix.
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
  const [auditId, setAuditId] = useState<string>('');
  const [groups, setGroups] = useState<AuditGroup[] | null>(null);
  const [diff, setDiff] = useState<AuditDiff | null>(null);
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!auditId && audits.length > 0) setAuditId(audits[0].id);
  }, [audits, auditId]);

  const loadShares = useCallback(async (id: string) => {
    try {
      const res = await auditsV2Api.listShares(id);
      setShares(res.data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load share links.');
    }
  }, []);

  useEffect(() => {
    if (!auditId) return;
    (async () => {
      try {
        const [g, d] = await Promise.all([auditsV2Api.groups(auditId), auditsV2Api.diff(auditId)]);
        setGroups(g.data);
        setDiff(d.diff);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Could not load audit v2 data.');
      }
      loadShares(auditId);
    })();
  }, [auditId, loadShares]);

  const createShareLink = async () => {
    if (!auditId) return;
    setBusy('share');
    setErr('');
    try {
      const created = await auditsV2Api.createShare(auditId, 30);
      setShareUrl(created.url);
      await loadShares(auditId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create share link.');
    } finally {
      setBusy('');
    }
  };

  const revoke = async (tokenId: string) => {
    if (!auditId) return;
    setBusy(tokenId);
    try {
      await auditsV2Api.revokeShare(auditId, tokenId);
      setShares((prev) => prev.filter((s) => s.id !== tokenId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not revoke share link.');
    } finally {
      setBusy('');
    }
  };

  const done = [...audits].filter((a) => a.status === 'done' && a.score != null).reverse();
  const scoreDelta =
    done.length >= 2 ? (done[done.length - 1].score ?? 0) - (done[done.length - 2].score ?? 0) : null;

  return (
    <div className="space-y-6">
      {err && <p className="bx-alert-err" role="alert">{err}</p>}

      <div className="bx-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="bx-micro mb-1">~/ fix planning</p>
            <h3 className="text-base font-bold text-white">Grouped fixes</h3>
            <p className="bx-body mt-1">Server-grouped by issue type, highest total impact first.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {audits.length > 1 && (
              <select value={auditId} onChange={(e) => setAuditId(e.target.value)} className="bx-input !w-auto !text-xs" aria-label="Audit for v2 panels">
                {audits.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.finished_at ? new Date(a.finished_at).toLocaleDateString() : a.status}
                  </option>
                ))}
              </select>
            )}
            {auditId && (
              <a href={auditsV2Api.exportUrl(auditId, 'csv')} className="bx-btn-secondary !text-xs">Export CSV</a>
            )}
            {auditId && (
              <a href={auditsV2Api.exportUrl(auditId, 'pdf')} className="bx-btn-secondary !text-xs">Export PDF</a>
            )}
            <button onClick={createShareLink} disabled={!auditId || busy === 'share'} className="bx-btn-secondary !text-xs">
              {busy === 'share' ? 'Creating…' : 'Shareable link'}
            </button>
          </div>
        </div>

        {shareUrl && (
          <div className="mt-3 flex items-center gap-2">
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
        )}

        {shares.length > 0 && (
          <ul className="mt-3 space-y-2">
            {shares.map((s) => (
              <li key={s.id} className="bx-panel flex items-center justify-between gap-3">
                <span className="font-mono text-xs text-white/50">
                  shared {new Date(s.created_at).toLocaleDateString()} · expires{' '}
                  {new Date(s.expires_at).toLocaleDateString()}
                </span>
                <button onClick={() => revoke(s.id)} disabled={busy === s.id} className="text-xs text-red-300/80 hover:text-red-300 hover:underline">
                  {busy === s.id ? 'Revoking…' : 'Revoke'}
                </button>
              </li>
            ))}
          </ul>
        )}

        {groups === null ? (
          <p className="mt-4 font-mono text-sm text-white/40">$ loading groups…</p>
        ) : groups.length === 0 ? (
          <p className="mt-4 text-sm text-white/40">No grouped issues for this audit yet.</p>
        ) : (
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {groups.map((g) => (
              <div key={g.type} className="bx-panel">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-white">{g.type}</span>
                  <span className="bx-pill bx-pill-info"><span className="bx-dot" />{g.count} page{g.count === 1 ? '' : 's'}</span>
                </div>
                <p className="mt-1 font-mono text-xs text-white/40">
                  {g.severity} · total impact {g.total_impact}
                </p>
                <p className="mt-1 text-xs text-white/60">{g.fix_suggestion}</p>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 font-mono text-[11px] text-white/30">
          Issue states: open · ignored · resolved · wont-fix — change them in the issue table above
          ({issues.length} issues loaded for the selected audit).
        </p>
      </div>

      {/* Change history: real audit list (props) + server diff */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ history</p>
        <h3 className="text-base font-bold text-white">Score history</h3>
        {done.length > 0 ? (
          <div className="mt-3">
            <div className="flex items-end gap-1" role="img" aria-label="Health score history chart">
              {done.map((h) => (
                <div key={h.id} className="flex-1" title={`${new Date(h.finished_at ?? h.started_at ?? '').toLocaleDateString()}: ${h.score}/100, ${h.issues_count} issues`}>
                  <div className="w-full rounded-t bg-gradient-to-t from-teal-500/60 to-cyan-300/80" style={{ height: `${Math.max(8, (h.score ?? 0) * 1.6)}px` }} />
                </div>
              ))}
            </div>
            <div className="mt-2 flex justify-between font-mono text-[11px] text-white/40">
              <span>{new Date(done[0].finished_at ?? '').toLocaleDateString()}</span>
              <span>
                latest: <strong className="text-teal-300">{done[done.length - 1].score}/100</strong>
                {scoreDelta !== null && scoreDelta !== 0 && (
                  <span className={scoreDelta > 0 ? 'text-teal-300' : 'text-red-300'}>
                    {' '}({scoreDelta > 0 ? '+' : ''}{scoreDelta} vs previous)
                  </span>
                )}
              </span>
            </div>
          </div>
        ) : (
          <p className="mt-2 text-sm text-white/40">No completed audits yet — run one to start the history.</p>
        )}
        {diff && (
          <p className="mt-3 font-mono text-xs text-white/50">
            vs previous crawl: {diff.new_issues} new issues · {diff.resolved_issues} resolved ·{' '}
            {diff.new_errors} new errors
          </p>
        )}
      </div>
    </div>
  );
}
