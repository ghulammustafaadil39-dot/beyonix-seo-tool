'use client';

import { useEffect, useState } from 'react';
import { withMockFallback, notLandedYet } from '@/lib/mock';
import {
  mockToxicLinks,
  mockAnchors,
  mockOpportunities,
  buildDisavowFile,
  downloadTextFile,
  type ToxicLink,
  type AnchorSlice,
  type LinkOpportunity,
} from '@/lib/mock/backlinks';
import MockBanner from '@/components/MockBanner';

/**
 * F-06 — Backlinks v2 UI extras: toxic link flags, anchor distribution,
 * link-building opportunities, disavow file generator.
 * Mock-backed (bannered) except the disavow file, which is client-side.
 */
export default function BacklinksV2Panel({ siteId }: { siteId: string }) {
  const [toxic, setToxic] = useState<ToxicLink[] | null>(null);
  const [anchors, setAnchors] = useState<AnchorSlice[] | null>(null);
  const [opps, setOpps] = useState<LinkOpportunity[] | null>(null);
  const [disavowSel, setDisavowSel] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      const [t, a, o] = await Promise.all([
        withMockFallback(() => notLandedYet<ToxicLink[]>(), mockToxicLinks),
        withMockFallback(() => notLandedYet<AnchorSlice[]>(), mockAnchors),
        withMockFallback(() => notLandedYet<LinkOpportunity[]>(), mockOpportunities),
      ]);
      setToxic(t.data);
      setAnchors(a.data);
      setOpps(o.data);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  const toggleDisavow = (url: string) => {
    setDisavowSel((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const downloadDisavow = () => {
    const domains = Array.from(disavowSel).map((u) => {
      try {
        return new URL(u).hostname;
      } catch {
        return u;
      }
    });
    downloadTextFile('disavow.txt', buildDisavowFile(domains));
  };

  const maxAnchor = Math.max(1, ...(anchors ?? []).map((a) => a.count));

  return (
    <div className="space-y-6">
      <div><MockBanner label="backlinks v2" /></div>

      {/* Toxic links + disavow */}
      <div className="bx-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="bx-micro mb-1">~/ link health</p>
            <h3 className="text-base font-bold text-white">Potentially toxic links</h3>
            <p className="bx-body mt-1">
              Review and disavow links that could hurt you. Select links to build a disavow file.
            </p>
          </div>
          <button
            onClick={downloadDisavow}
            disabled={disavowSel.size === 0}
            className="bx-btn-secondary !text-xs"
          >
            Download disavow.txt ({disavowSel.size})
          </button>
        </div>
        <ul className="mt-3 space-y-2">
          {(toxic ?? []).map((t) => (
            <li key={t.source_url}>
              <label className="flex cursor-pointer items-start gap-3 bx-panel">
                <input
                  type="checkbox"
                  checked={disavowSel.has(t.source_url)}
                  onChange={() => toggleDisavow(t.source_url)}
                  className="mt-1 accent-teal-400"
                  aria-label={`Disavow ${t.source_url}`}
                />
                <div>
                  <p className="font-mono text-sm text-white">{t.source_url}</p>
                  <p className="mt-1 text-xs text-white/50">{t.reason}</p>
                  <span className={`bx-pill mt-2 ${t.risk === 'high' ? 'bx-pill-err' : 'bx-pill-warn'}`}>
                    <span className="bx-dot" />
                    {t.risk} risk
                  </span>
                </div>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Anchor distribution */}
        <div className="bx-card">
          <p className="bx-micro mb-1">~/ anchors</p>
          <h3 className="text-base font-bold text-white">Anchor text distribution</h3>
          <div className="mt-4 space-y-3">
            {(anchors ?? []).map((a) => (
              <div key={a.anchor}>
                <div className="flex justify-between text-xs">
                  <span className="font-mono text-white/70">{a.anchor}</span>
                  <span className="font-mono text-white/40">{a.count}</span>
                </div>
                <div className="bx-meter-track">
                  <div className="bx-meter-fill" style={{ width: `${(a.count / maxAnchor) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Opportunities */}
        <div className="bx-card">
          <p className="bx-micro mb-1">~/ opportunities</p>
          <h3 className="text-base font-bold text-white">Link-building opportunities</h3>
          <ul className="mt-3 space-y-2">
            {(opps ?? []).map((o) => (
              <li key={o.id} className="bx-panel">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-mono text-sm font-medium text-white">{o.domain}</p>
                  <span className="bx-pill bx-pill-info">
                    <span className="bx-dot" />
                    {o.type} · {o.difficulty}
                  </span>
                </div>
                <p className="mt-1 text-xs text-white/55">{o.note}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
