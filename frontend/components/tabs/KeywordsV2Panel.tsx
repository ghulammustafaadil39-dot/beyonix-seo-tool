'use client';

import { useEffect, useState } from 'react';
import { withMockFallback, notLandedYet } from '@/lib/mock';
import {
  mockClusters,
  mockCannibalization,
  mockKeywordGap,
  parseKeywordList,
  type KeywordCluster,
  type Cannibalization,
  type KeywordGap,
} from '@/lib/mock/keywords';
import MockBanner from '@/components/MockBanner';

const INTENT_PILL: Record<string, string> = {
  informational: 'bx-pill-info',
  commercial: 'bx-pill-sky',
  transactional: 'bx-pill-ok',
  navigational: 'bx-pill-violet',
};

/**
 * F-03 — Keyword v2 UI extras: clustering by intent/topic, cannibalization
 * detection, keyword gap vs competitors, bulk import, lists/tags.
 * All mock-backed (bannered) until the endpoints land.
 */
export default function KeywordsV2Panel({ siteId }: { siteId: string }) {
  const [clusters, setClusters] = useState<KeywordCluster[] | null>(null);
  const [cannib, setCannib] = useState<Cannibalization[] | null>(null);
  const [gap, setGap] = useState<KeywordGap[] | null>(null);
  const [bulk, setBulk] = useState('');
  const [parsed, setParsed] = useState<string[]>([]);
  const [imported, setImported] = useState(false);

  useEffect(() => {
    (async () => {
      const [c, cb, g] = await Promise.all([
        withMockFallback(() => notLandedYet<KeywordCluster[]>(), mockClusters),
        withMockFallback(() => notLandedYet<Cannibalization[]>(), mockCannibalization),
        withMockFallback(() => notLandedYet<KeywordGap[]>(), mockKeywordGap),
      ]);
      setClusters(c.data);
      setCannib(cb.data);
      setGap(g.data);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  useEffect(() => setParsed(parseKeywordList(bulk)), [bulk]);

  const doImport = async () => {
    // Bulk import endpoint pending — parse locally, show what's staged.
    setImported(true);
    setTimeout(() => setImported(false), 4000);
  };

  return (
    <div className="space-y-6">
      <div><MockBanner label="keyword research v2" /></div>

      {/* Clusters */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ clusters</p>
        <h3 className="text-base font-bold text-white">Keyword clusters by intent</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(clusters ?? []).map((c) => (
            <div key={c.id} className="bx-panel">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-white">{c.name}</p>
                <span className={`bx-pill ${INTENT_PILL[c.intent] ?? 'bx-pill-info'}`}>
                  <span className="bx-dot" />
                  {c.intent}
                </span>
              </div>
              <p className="mt-1 font-mono text-xs text-white/40">
                {c.keywords.length} keywords · {c.total_volume.toLocaleString()} vol/mo
              </p>
              <ul className="mt-2 space-y-1">
                {c.keywords.map((k) => (
                  <li key={k} className="font-mono text-xs text-white/60">· {k}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* Cannibalization + gap */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="bx-card">
          <p className="bx-micro mb-1">~/ cannibalization</p>
          <h3 className="text-base font-bold text-white">Cannibalization watch</h3>
          <div className="mt-3 space-y-3">
            {(cannib ?? []).map((c, i) => (
              <div key={i} className="bx-panel">
                <p className="font-mono text-sm font-semibold text-amber-300">{c.keyword}</p>
                <ul className="mt-1 space-y-0.5">
                  {c.urls.map((u) => (
                    <li key={u} className="font-mono text-xs text-white/50">{u}</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs leading-relaxed text-white/60">{c.recommendation}</p>
              </div>
            ))}
            {cannib?.length === 0 && <p className="text-sm text-white/40">No cannibalization detected.</p>}
          </div>
        </div>
        <div className="bx-card">
          <p className="bx-micro mb-1">~/ keyword gap</p>
          <h3 className="text-base font-bold text-white">Gap vs competitors</h3>
          <p className="bx-body mt-1">Keywords competitors rank for that you don&rsquo;t.</p>
          <div className="mt-3 space-y-2">
            {(gap ?? []).map((g) => (
              <div key={g.keyword} className="flex items-center justify-between gap-3 bx-panel">
                <div>
                  <p className="font-mono text-sm font-medium text-white">{g.keyword}</p>
                  <p className="font-mono text-xs text-white/40">
                    {g.volume.toLocaleString()} vol/mo · difficulty {g.difficulty} · {g.competitors_ranking.join(', ')}
                  </p>
                </div>
                <button className="bx-btn-xs-secondary" aria-label={`Track ${g.keyword}`}>
                  Track
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bulk import */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ bulk import</p>
        <h3 className="text-base font-bold text-white">Import keyword list</h3>
        <p className="bx-body mt-1">
          Paste keywords (one per line or comma-separated). Server-side import is
          pending — what you paste is parsed locally for now.
        </p>
        <label htmlFor="bulk-keywords" className="bx-label mt-3">Keywords</label>
        <textarea
          id="bulk-keywords"
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
          rows={5}
          placeholder={"invoicing software\nbest crm for freelancers, seo reporting tool"}
          className="bx-input font-mono"
        />
        <div className="mt-3 flex items-center justify-between">
          <p className="font-mono text-xs text-white/40">
            {parsed.length} keyword{parsed.length === 1 ? '' : 's'} parsed
          </p>
          <button onClick={doImport} disabled={parsed.length === 0} className="bx-btn-primary">
            {imported ? 'Staged ✓ (server import pending)' : 'Import keywords'}
          </button>
        </div>
      </div>
    </div>
  );
}
