'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  backlinksV2Api,
  type LinkOpportunity,
  type ToxicLink,
} from '@/lib/api';

/**
 * F-06 — Backlinks v2 (WIRED, Wave 2 round 2): anchor distribution,
 * heuristic toxic list, opportunities, disavow download, rescore.
 * Toxic flags are HEURISTICS (the API labels them as such) — never a
 * measured penalty verdict; the UI keeps that label.
 */
export default function BacklinksV2Panel({ siteId }: { siteId: string }) {
  const [toxic, setToxic] = useState<ToxicLink[] | null>(null);
  const [toxicNote, setToxicNote] = useState('');
  const [anchors, setAnchors] = useState<Array<{ anchor: string; links: number }> | null>(null);
  const [opps, setOpps] = useState<LinkOpportunity[] | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [t, a, o] = await Promise.all([
        backlinksV2Api.toxic(siteId),
        backlinksV2Api.anchors(siteId),
        backlinksV2Api.opportunities(siteId),
      ]);
      setToxic(t.links);
      setToxicNote(t.note);
      setAnchors(a.anchors);
      setOpps(o.opportunities);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load backlinks v2 data.');
    }
  }, [siteId]);

  useEffect(() => {
    load();
  }, [load]);

  const rescore = async () => {
    setBusy('rescore');
    setErr('');
    try {
      const res = await backlinksV2Api.rescore(siteId);
      setMsg(`Rescored ${res.rescored} links — ${res.toxic} flagged toxic (heuristic).`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Rescore failed.');
    } finally {
      setBusy('');
    }
  };

  const refreshOpps = async () => {
    setBusy('opps');
    setErr('');
    try {
      const res = await backlinksV2Api.refreshOpportunities(siteId);
      setOpps(res.opportunities);
      setMsg(`Found ${res.total} link opportunities (heuristic).`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Opportunity refresh failed.');
    } finally {
      setBusy('');
    }
  };

  const maxAnchor = Math.max(1, ...(anchors ?? []).map((a) => a.links));

  return (
    <div className="space-y-6">
      {err && <p className="bx-alert-err" role="alert">{err}</p>}
      {msg && <p className="bx-alert-ok">{msg}</p>}

      {/* Toxic links + disavow */}
      <div className="bx-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="bx-micro mb-1">~/ link health</p>
            <h3 className="text-base font-bold text-white">Potentially toxic links (heuristic)</h3>
            <p className="bx-body mt-1">
              {toxicNote || 'Flags are heuristics, not a measured penalty risk. Review before disavowing.'}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={rescore} disabled={busy === 'rescore'} className="bx-btn-secondary !text-xs">
              {busy === 'rescore' ? 'Rescoring…' : 'Rescore links'}
            </button>
            <a href={backlinksV2Api.disavowUrl(siteId)} className="bx-btn-secondary !text-xs">
              Download disavow file
            </a>
          </div>
        </div>
        {toxic === null ? (
          <p className="mt-3 font-mono text-sm text-white/55">Loading toxic links…</p>
        ) : toxic.length === 0 ? (
          <p className="mt-3 text-sm text-white/55">No links at or above the toxic threshold — nothing to review.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {toxic.map((t) => (
              <li key={t.id} className="bx-panel">
                <p className="break-all font-mono text-sm text-white">{t.source_url}</p>
                <p className="mt-1 font-mono text-xs text-white/55">
                  score {t.toxic_score}/100{t.anchor_text ? ` · anchor “${t.anchor_text}”` : ''}
                  {t.referring_domain ? ` · ${t.referring_domain}` : ''}
                </p>
                {t.toxic_flags && t.toxic_flags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {t.toxic_flags.map((f) => (
                      <span key={f} className="bx-pill bx-pill-warn"><span className="bx-dot" />{f}</span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Anchor distribution */}
        <div className="bx-card">
          <p className="bx-micro mb-1">~/ anchors</p>
          <h3 className="text-base font-bold text-white">Anchor text distribution</h3>
          {anchors === null ? (
            <p className="mt-3 font-mono text-sm text-white/55">Loading…</p>
          ) : anchors.length === 0 ? (
            <p className="mt-3 text-sm text-white/55">No active backlinks yet.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {anchors.map((a) => (
                <div key={a.anchor}>
                  <div className="flex justify-between text-xs">
                    <span className="font-mono text-white/70">{a.anchor}</span>
                    <span className="font-mono text-white/55">{a.links}</span>
                  </div>
                  <div className="bx-meter-track">
                    <div className="bx-meter-fill" style={{ width: `${(a.links / maxAnchor) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Opportunities */}
        <div className="bx-card">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="bx-micro mb-1">~/ opportunities</p>
              <h3 className="text-base font-bold text-white">Link-building opportunities</h3>
              <p className="bx-body mt-1">Heuristic: lost links to reclaim and unlinked brand mentions.</p>
            </div>
            <button onClick={refreshOpps} disabled={busy === 'opps'} className="bx-btn-secondary shrink-0 !text-xs">
              {busy === 'opps' ? 'Finding…' : 'Refresh'}
            </button>
          </div>
          {opps === null ? (
            <p className="mt-3 font-mono text-sm text-white/55">Loading…</p>
          ) : opps.length === 0 ? (
            <p className="mt-3 text-sm text-white/55">No opportunities yet — hit Refresh to scan.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {opps.map((o) => (
                <li key={o.id} className="bx-panel">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-mono text-sm font-medium text-white">{o.source_domain}</p>
                    <span className="bx-pill bx-pill-info"><span className="bx-dot" />{o.kind}</span>
                  </div>
                  <p className="mt-1 text-xs text-white/55">{o.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
