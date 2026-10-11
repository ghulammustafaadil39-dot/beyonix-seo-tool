'use client';

import { useEffect, useState } from 'react';
import { withMockFallback, notLandedYet } from '@/lib/mock';
import {
  mockVersions,
  mockPlagiarism,
  PUBLISH_TARGETS,
  type ContentVersion,
  type PlagiarismResult,
} from '@/lib/mock/content';
import MockBanner from '@/components/MockBanner';

/**
 * F-04 — Content v2 UI extras: version history, plagiarism check,
 * publish connectors. All mock-backed (bannered) until endpoints land.
 */
export default function ContentV2Panel({ contentId }: { contentId: string }) {
  const [versions, setVersions] = useState<ContentVersion[] | null>(null);
  const [plag, setPlag] = useState<PlagiarismResult | null>(null);
  const [plagBusy, setPlagBusy] = useState(false);
  const [target, setTarget] = useState<(typeof PUBLISH_TARGETS)[number]>('wordpress');
  const [publishMsg, setPublishMsg] = useState('');

  useEffect(() => {
    (async () => {
      const { data } = await withMockFallback(
        () => notLandedYet<ContentVersion[]>(),
        mockVersions,
      );
      setVersions(data);
    })();
  }, [contentId]);

  const checkPlagiarism = async () => {
    setPlagBusy(true);
    try {
      const { data } = await withMockFallback(
        () => notLandedYet<PlagiarismResult>(),
        mockPlagiarism,
      );
      setPlag(data);
    } finally {
      setPlagBusy(false);
    }
  };

  const publish = () => {
    setPublishMsg(
      `Publish connector for ${target} is pending — export HTML from the content page for now.`,
    );
    setTimeout(() => setPublishMsg(''), 5000);
  };

  return (
    <div className="space-y-6">
      <div><MockBanner label="content v2" /></div>

      {/* Version history */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ versions</p>
        <h3 className="text-base font-bold text-white">Version history</h3>
        <ol className="mt-3 space-y-2">
          {(versions ?? []).map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-3 bx-panel">
              <div>
                <p className="text-sm font-medium text-white">v{v.version} — {v.title}</p>
                <p className="font-mono text-xs text-white/40">
                  {new Date(v.created_at).toLocaleString()} · {v.words.toLocaleString()} words · {v.author}
                </p>
              </div>
              <button className="bx-btn-xs-secondary">Restore</button>
            </li>
          ))}
        </ol>
      </div>

      {/* Plagiarism + publish */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="bx-card">
          <p className="bx-micro mb-1">~/ originality</p>
          <h3 className="text-base font-bold text-white">Plagiarism check</h3>
          <p className="bx-body mt-1">Verify the draft is original before publishing.</p>
          <button onClick={checkPlagiarism} disabled={plagBusy} className="bx-btn-primary mt-3">
            {plagBusy ? 'Checking…' : plag ? 'Re-check' : 'Run check'}
          </button>
          {plag && (
            <div className="mt-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-white/70">Uniqueness</span>
                <span className="font-mono font-bold text-teal-300">{plag.score}%</span>
              </div>
              <div className="bx-meter-track">
                <div className="bx-meter-fill" style={{ width: `${plag.score}%` }} />
              </div>
              {plag.matches.map((m, i) => (
                <p key={i} className="mt-2 font-mono text-xs text-white/40">
                  {m.percent}% similar: {m.url}
                </p>
              ))}
              <p className="mt-2 font-mono text-[11px] text-white/30">
                checked {new Date(plag.checked_at).toLocaleString()}
              </p>
            </div>
          )}
        </div>
        <div className="bx-card">
          <p className="bx-micro mb-1">~/ publish</p>
          <h3 className="text-base font-bold text-white">Publish connector</h3>
          <p className="bx-body mt-1">
            Push approved drafts straight to your CMS.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label htmlFor="publish-target" className="bx-label !mb-0">Target</label>
            <select
              id="publish-target"
              value={target}
              onChange={(e) => setTarget(e.target.value as typeof target)}
              className="bx-input !w-auto"
            >
              {PUBLISH_TARGETS.map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
            <button onClick={publish} className="bx-btn-primary">
              Publish
            </button>
          </div>
          {publishMsg && <p className="bx-alert-info mt-3">{publishMsg}</p>}
        </div>
      </div>
    </div>
  );
}
