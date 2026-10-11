'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  competitorsApi,
  type Competitor,
  type CompetitorCompare,
  type CompetitorGap,
} from '@/lib/api';

/**
 * F-07 — Competitor analysis (WIRED, Wave 2 round 2): competitors CRUD,
 * visibility compare, keyword/content gaps, backlink compare against the
 * real Backend-B endpoints. Competitor backlink counts are `unavailable`
 * (no backlinks provider wired) and are rendered honestly as such.
 */
export default function CompetitorsTab({ siteId }: { siteId: string }) {
  const [competitors, setCompetitors] = useState<Competitor[] | null>(null);
  const [compare, setCompare] = useState<CompetitorCompare | null>(null);
  const [kwGaps, setKwGaps] = useState<CompetitorGap[] | null>(null);
  const [contentGaps, setContentGaps] = useState<Array<CompetitorGap & { suggestion: string }> | null>(null);
  const [backlinks, setBacklinks] = useState<{
    site: { domain: string; links: number; referringDomains: number };
    competitors: Array<{ domain: string; data: 'unavailable' }>;
    note: string;
  } | null>(null);
  const [newDomain, setNewDomain] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [c, cmp, kg, cg, bl] = await Promise.all([
        competitorsApi.list(siteId),
        competitorsApi.compare(siteId),
        competitorsApi.keywordGaps(siteId),
        competitorsApi.contentGaps(siteId),
        competitorsApi.backlinks(siteId),
      ]);
      setCompetitors(c.competitors);
      setCompare(cmp);
      setKwGaps(kg.gaps);
      setContentGaps(cg.gaps);
      setBacklinks(bl as typeof backlinks);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load competitor data.');
    }
  }, [siteId]);

  useEffect(() => {
    load();
  }, [load]);

  const addCompetitor = async (e: React.FormEvent) => {
    e.preventDefault();
    const domain = newDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      setErr('Enter a valid domain, e.g. competitor.com');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await competitorsApi.add(siteId, domain, newLabel.trim() || undefined);
      setNewDomain('');
      setNewLabel('');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not add competitor.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: Competitor) => {
    try {
      await competitorsApi.remove(siteId, c.id);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not remove competitor.');
    }
  };

  const summaryByDomain = new Map((compare?.summary ?? []).map((s) => [s.domain, s]));
  const maxVis = Math.max(0.01, ...(compare?.summary ?? []).map((s) => s.visibilitySharePct));

  return (
    <div className="space-y-6">
      {err && <p className="bx-alert-err" role="alert">{err}</p>}

      {/* CRUD + visibility compare */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ competitors</p>
        <h2 className="text-base font-bold text-white">Tracked competitors</h2>
        <form onSubmit={addCompetitor} className="mt-3 flex flex-wrap gap-2">
          <input value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="competitor.com" className="bx-input flex-1 font-mono" aria-label="Competitor domain" />
          <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Label (optional)" className="bx-input !w-auto" aria-label="Competitor label" />
          <button type="submit" disabled={busy} className="bx-btn-primary shrink-0">{busy ? 'Adding…' : 'Add'}</button>
        </form>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {(competitors ?? []).map((c) => {
            const s = summaryByDomain.get(c.domain);
            return (
              <div key={c.id} className="bx-panel">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-mono text-sm font-semibold text-white">
                    {c.domain}
                    {c.label ? <span className="ml-2 font-sans text-xs font-normal text-white/40">{c.label}</span> : null}
                  </p>
                  <button onClick={() => remove(c)} className="text-xs text-red-300/80 hover:text-red-300 hover:underline" aria-label={`Remove ${c.domain}`}>
                    Remove
                  </button>
                </div>
                <div className="mt-3">
                  <div className="flex justify-between text-xs">
                    <span className="text-white/50">Visibility share (your tracked keywords)</span>
                    <span className="font-mono text-white/70">{s ? s.visibilitySharePct : '—'}</span>
                  </div>
                  <div className="bx-meter-track">
                    <div className="bx-meter-fill" style={{ width: `${((s?.visibilitySharePct ?? 0) / maxVis) * 100}%` }} />
                  </div>
                </div>
                <p className="mt-2 font-mono text-xs text-white/40">
                  {s ? `${s.keywords} keywords compared` : 'no rank data yet'} · added{' '}
                  {new Date(c.created_at).toLocaleDateString()}
                </p>
              </div>
            );
          })}
          {competitors !== null && competitors.length === 0 && (
            <p className="text-sm text-white/40">No competitors yet — add one above.</p>
          )}
          {competitors === null && <p className="font-mono text-sm text-white/40">$ loading competitors…</p>}
        </div>
        {compare && compare.summary.length > 0 && (
          <p className="mt-3 font-mono text-xs text-white/40">
            Your site ({compare.site}): visibility share{' '}
            {summaryByDomain.get(compare.site)?.visibilitySharePct ?? '—'} across{' '}
            {compare.keywords.length} tracked keywords with rank data.
          </p>
        )}
      </div>

      {/* Keyword gaps */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ keyword gaps</p>
        <h2 className="text-base font-bold text-white">Keywords competitors outrank you on</h2>
        {kwGaps === null ? (
          <p className="mt-3 font-mono text-sm text-white/40">$ loading…</p>
        ) : kwGaps.length === 0 ? (
          <p className="mt-3 text-sm text-white/40">No keyword gaps found in the latest rank snapshots.</p>
        ) : (
          <div className="bx-table-wrap mt-3">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="bx-th">Keyword</th>
                  <th className="bx-th">Volume</th>
                  <th className="bx-th">Competitor</th>
                  <th className="bx-th">Their position</th>
                  <th className="bx-th">Your position</th>
                </tr>
              </thead>
              <tbody className="bx-tbody">
                {kwGaps.map((g, i) => (
                  <tr key={i}>
                    <td className="px-4 py-3 font-mono text-white/85">{g.keyword}</td>
                    <td className="px-4 py-3 font-mono text-white/60">{g.volume != null ? g.volume.toLocaleString() : '—'}</td>
                    <td className="px-4 py-3 font-mono text-white/60">{g.competitor}</td>
                    <td className="px-4 py-3"><span className="bx-pill bx-pill-ok"><span className="bx-dot" />#{g.competitorPosition}</span></td>
                    <td className="px-4 py-3 font-mono text-white/60">{g.sitePosition === null ? '—' : `#${g.sitePosition}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Content gaps */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ content gaps</p>
        <h2 className="text-base font-bold text-white">Content gaps</h2>
        {contentGaps === null ? (
          <p className="mt-3 font-mono text-sm text-white/40">$ loading…</p>
        ) : contentGaps.length === 0 ? (
          <p className="mt-3 text-sm text-white/40">No content gaps — every competitor-ranking keyword already has content, or no rank data yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {contentGaps.map((g, i) => (
              <li key={i} className="bx-panel">
                <p className="font-mono text-sm font-medium text-white">
                  {g.keyword} <span className="text-white/40">— {g.competitor} ranks #{g.competitorPosition}</span>
                </p>
                <p className="mt-1 text-xs text-white/55">{g.suggestion}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Backlink compare (honest unavailable) */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ backlink compare</p>
        <h2 className="text-base font-bold text-white">Backlink comparison</h2>
        {backlinks === null ? (
          <p className="mt-3 font-mono text-sm text-white/40">$ loading…</p>
        ) : (
          <div className="mt-3 space-y-2">
            <p className="font-mono text-sm text-white/80">
              {backlinks.site.domain}: {backlinks.site.links.toLocaleString()} links ·{' '}
              {backlinks.site.referringDomains.toLocaleString()} referring domains (your uploaded data)
            </p>
            {backlinks.competitors.map((c) => (
              <p key={c.domain} className="font-mono text-sm text-white/40">
                {c.domain}: <span className="bx-pill bx-pill-warn"><span className="bx-dot" />unavailable</span>
              </p>
            ))}
            <p className="text-xs leading-relaxed text-white/50">{backlinks.note}</p>
          </div>
        )}
      </div>
    </div>
  );
}
