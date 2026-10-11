'use client';

import { useEffect, useState } from 'react';
import { withMockFallback, notLandedYet } from '@/lib/mock';
import {
  mockPrompts,
  mockShareOfVoice,
  mockGeoRecommendations,
  type GeoPrompt,
  type ShareOfVoice,
  type GeoRecommendation,
} from '@/lib/mock/geo';
import MockBanner from '@/components/MockBanner';

const EFFORT_PILL: Record<string, string> = {
  'quick win': 'bx-pill-ok',
  medium: 'bx-pill-warn',
  project: 'bx-pill-info',
};

/**
 * F-05 — GEO v2 UI extras: prompt sets, share-of-voice vs competitors,
 * citation recommendations. Mock-backed (bannered) until endpoints land.
 */
export default function GeoV2Panel({ siteId }: { siteId: string }) {
  const [prompts, setPrompts] = useState<GeoPrompt[] | null>(null);
  const [sov, setSov] = useState<ShareOfVoice[] | null>(null);
  const [recs, setRecs] = useState<GeoRecommendation[] | null>(null);
  const [newPrompt, setNewPrompt] = useState('');
  const [promptList, setPromptList] = useState<GeoPrompt[]>([]);

  useEffect(() => {
    (async () => {
      const [p, s, r] = await Promise.all([
        withMockFallback(() => notLandedYet<GeoPrompt[]>(), mockPrompts),
        withMockFallback(() => notLandedYet<ShareOfVoice[]>(), mockShareOfVoice),
        withMockFallback(() => notLandedYet<GeoRecommendation[]>(), mockGeoRecommendations),
      ]);
      setPrompts(p.data);
      setPromptList(p.data);
      setSov(s.data);
      setRecs(r.data);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  const addPrompt = (e: React.FormEvent) => {
    e.preventDefault();
    const text = newPrompt.trim();
    if (!text) return;
    setPromptList((prev) => [
      ...prev,
      { id: `local_${Date.now()}`, prompt: text, engines: ['chatgpt', 'perplexity', 'gemini', 'claude'], last_checked: 'not checked yet' },
    ]);
    setNewPrompt('');
  };

  return (
    <div className="space-y-6">
      <div><MockBanner label="GEO v2" /></div>

      {/* Prompt sets */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ prompt sets</p>
        <h3 className="text-base font-bold text-white">Tracked prompts</h3>
        <p className="bx-body mt-1">
          The real questions your customers ask AI assistants.
        </p>
        <form onSubmit={addPrompt} className="mt-3 flex gap-2">
          <input
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
            placeholder="e.g. best crm for a 5-person agency"
            className="bx-input"
            aria-label="New prompt to track"
          />
          <button type="submit" className="bx-btn-primary shrink-0">
            Add prompt
          </button>
        </form>
        <ul className="mt-4 space-y-2">
          {promptList.map((p) => (
            <li key={p.id} className="bx-panel flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-mono text-sm text-white">{p.prompt}</p>
                <p className="font-mono text-xs text-white/40">
                  {p.engines.join(' · ')} — {p.last_checked === 'not checked yet' ? p.last_checked : `checked ${new Date(p.last_checked).toLocaleDateString()}`}
                </p>
              </div>
              <span className="bx-pill bx-pill-info">
                <span className="bx-dot" />
                {p.engines.length} engines
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Share of voice */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ share of voice</p>
        <h3 className="text-base font-bold text-white">AI citation share of voice</h3>
        <div className="mt-4 space-y-4">
          {(sov ?? []).map((s) => (
            <div key={s.brand}>
              <div className="flex justify-between text-sm">
                <span className={`font-medium ${s.you ? 'text-teal-300' : 'text-white/70'}`}>
                  {s.brand}
                </span>
                <span className="font-mono text-xs text-white/40">
                  mentioned {s.mention_rate}% · cited {s.citation_rate}%
                </span>
              </div>
              <div className="bx-meter-track">
                <div
                  className={s.you ? 'bx-meter-fill' : 'h-full rounded-full bg-white/20'}
                  style={{ width: `${s.citation_rate}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recommendations */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ recommendations</p>
        <h3 className="text-base font-bold text-white">Win more AI citations</h3>
        <div className="mt-3 space-y-2">
          {(recs ?? []).map((r) => (
            <div key={r.id} className="flex items-start justify-between gap-3 bx-panel">
              <div>
                <p className="text-sm font-semibold text-white">{r.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-white/60">{r.detail}</p>
              </div>
              <span className={`bx-pill shrink-0 ${EFFORT_PILL[r.effort] ?? 'bx-pill-info'}`}>
                <span className="bx-dot" />
                {r.effort}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
