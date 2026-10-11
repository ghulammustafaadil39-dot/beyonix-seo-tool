'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  geoV2Api,
  GEO_ENGINES,
  type GeoPrompt,
} from '@/lib/api';

const PRIORITY_PILL: Record<string, string> = {
  high: 'bx-pill-err',
  medium: 'bx-pill-warn',
  low: 'bx-pill-info',
};

/**
 * F-05 — GEO v2 (WIRED, Wave 2 round 2): prompt sets CRUD + run-set,
 * share-of-voice, recommendations, history, llms.txt download.
 * HONESTY: all GEO data is a SIMULATED estimate (backend marks
 * simulated:true) — the labeling below must never be removed.
 */
export default function GeoV2Panel({ siteId }: { siteId: string }) {
  const [prompts, setPrompts] = useState<GeoPrompt[] | null>(null);
  const [sov, setSov] = useState<Array<{ domain: string; mentions: number; checks: number; mentionRatePct: number }> | null>(null);
  const [recs, setRecs] = useState<Array<{ priority: 'high' | 'medium' | 'low'; title: string; detail: string }> | null>(null);
  const [history, setHistory] = useState<Array<{ date: string; platform: string; checks: number; mentions: number; mentionRatePct: number }> | null>(null);
  const [newPrompt, setNewPrompt] = useState('');
  const [runMsg, setRunMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [p, s, r, h] = await Promise.all([
        geoV2Api.prompts(siteId),
        geoV2Api.shareOfVoice(siteId),
        geoV2Api.recommendations(siteId),
        geoV2Api.history(siteId),
      ]);
      setPrompts(p.prompts);
      setSov(s.rows);
      setRecs(r.recommendations);
      setHistory(h.points);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load GEO v2 data.');
    }
  }, [siteId]);

  useEffect(() => {
    load();
  }, [load]);

  const addPrompt = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = newPrompt.trim();
    if (text.length < 3) return;
    setBusy('add');
    setErr('');
    try {
      const created = await geoV2Api.addPrompt(siteId, text);
      setPrompts((prev) => [...(prev ?? []), created]);
      setNewPrompt('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not add prompt.');
    } finally {
      setBusy('');
    }
  };

  const removePrompt = async (id: string) => {
    try {
      await geoV2Api.deletePrompt(siteId, id);
      setPrompts((prev) => (prev ?? []).filter((p) => p.id !== id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not delete prompt.');
    }
  };

  const runSet = async () => {
    setBusy('run');
    setErr('');
    setRunMsg('');
    try {
      const res = await geoV2Api.runSet(siteId);
      setRunMsg(`Prompt set run complete (simulated estimate). ${res.disclaimer}`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Run-set failed.');
    } finally {
      setBusy('');
    }
  };

  const maxRate = Math.max(1, ...(sov ?? []).map((s) => s.mentionRatePct));

  return (
    <div className="space-y-6">
      <p className="bx-alert-info">
        <strong>Simulated estimate:</strong> no public API exposes real AI-platform answers. Every
        GEO result here is simulated by our own LLM and is directional only.
      </p>
      {err && <p className="bx-alert-err" role="alert">{err}</p>}

      {/* Prompt sets */}
      <div className="bx-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="bx-micro mb-1">~/ prompt sets</p>
            <h3 className="text-base font-bold text-white">Tracked prompts (simulated)</h3>
            <p className="bx-body mt-1">
              The same prompts run on every engine: {GEO_ENGINES.join(' · ')}. Max 25 per site.
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={runSet} disabled={busy === 'run' || !prompts || prompts.length === 0} className="bx-btn-primary !text-xs">
              {busy === 'run' ? 'Running…' : 'Run prompt set'}
            </button>
            <a href={geoV2Api.llmsTxtUrl(siteId)} className="bx-btn-secondary !text-xs">Download llms.txt</a>
          </div>
        </div>
        {runMsg && <p className="bx-alert-ok mt-3">{runMsg}</p>}
        <form onSubmit={addPrompt} className="mt-3 flex gap-2">
          <input
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
            placeholder="e.g. best crm for a 5-person agency"
            className="bx-input"
            aria-label="New prompt to track"
          />
          <button type="submit" disabled={busy === 'add'} className="bx-btn-primary shrink-0">
            {busy === 'add' ? 'Adding…' : 'Add prompt'}
          </button>
        </form>
        <ul className="mt-4 space-y-2">
          {(prompts ?? []).map((p) => (
            <li key={p.id} className="bx-panel flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-mono text-sm text-white">{p.prompt}</p>
                <p className="font-mono text-xs text-white/55">added {new Date(p.created_at).toLocaleDateString()}</p>
              </div>
              <button onClick={() => removePrompt(p.id)} className="text-xs text-red-300/80 hover:text-red-300 hover:underline" aria-label={`Delete prompt ${p.prompt}`}>
                Delete
              </button>
            </li>
          ))}
          {prompts !== null && prompts.length === 0 && (
            <li className="text-sm text-white/55">No prompts yet — add your first one above.</li>
          )}
          {prompts === null && <li className="font-mono text-sm text-white/55">$ loading prompts…</li>}
        </ul>
      </div>

      {/* Share of voice */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ share of voice</p>
        <h3 className="text-base font-bold text-white">AI mention share of voice (simulated)</h3>
        {sov === null ? (
          <p className="mt-3 font-mono text-sm text-white/55">$ loading…</p>
        ) : sov.length === 0 ? (
          <p className="mt-3 text-sm text-white/55">No simulated checks yet — run the prompt set to build share-of-voice data.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {sov.map((s) => (
              <div key={s.domain}>
                <div className="flex justify-between text-sm">
                  <span className="font-medium text-white/70">{s.domain}</span>
                  <span className="font-mono text-xs text-white/55">
                    mentioned in {s.mentionRatePct}% ({s.mentions}/{s.checks} simulated checks)
                  </span>
                </div>
                <div className="bx-meter-track">
                  <div className="bx-meter-fill" style={{ width: `${(s.mentionRatePct / maxRate) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* History */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ history</p>
        <h3 className="text-base font-bold text-white">Mention history (simulated, 30 days)</h3>
        {history === null ? (
          <p className="mt-3 font-mono text-sm text-white/55">$ loading…</p>
        ) : history.length === 0 ? (
          <p className="mt-3 text-sm text-white/55">No check history yet.</p>
        ) : (
          <ul className="mt-3 space-y-1">
            {history.slice(-12).map((h, i) => (
              <li key={i} className="flex justify-between font-mono text-xs text-white/50">
                <span>{h.date} · {h.platform}</span>
                <span>{h.mentionRatePct}% ({h.mentions}/{h.checks})</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Recommendations */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ recommendations</p>
        <h3 className="text-base font-bold text-white">Win more AI citations</h3>
        <div className="mt-3 space-y-2">
          {(recs ?? []).map((r, i) => (
            <div key={i} className="flex items-start justify-between gap-3 bx-panel">
              <div>
                <p className="text-sm font-semibold text-white">{r.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-white/60">{r.detail}</p>
              </div>
              <span className={`bx-pill shrink-0 ${PRIORITY_PILL[r.priority] ?? 'bx-pill-info'}`}>
                <span className="bx-dot" />
                {r.priority}
              </span>
            </div>
          ))}
          {recs !== null && recs.length === 0 && <p className="text-sm text-white/55">No recommendations right now.</p>}
        </div>
      </div>
    </div>
  );
}
