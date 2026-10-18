'use client';

import { useEffect, useState } from 'react';
import { geoReadinessApi, type GeoReadinessCheck, type GeoReadinessResult, type GeoFix } from '@/lib/api';
import { useErrorReporter } from '../ErrorBanner';
import ScoreGauge from '../ScoreGauge';

/**
 * Phase 5: GEO readiness panel — FREE AI-visibility audit.
 * Beginner-friendly: plain language, checklist, in-place fix buttons.
 */
export default function GeoReadinessPanel({ siteId }: { siteId: string }) {
  const { report } = useErrorReporter();
  const [data, setData] = useState<{ score: number | null; checks: GeoReadinessCheck[]; checked_at: string | null; message?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [fix, setFix] = useState<GeoFix | null>(null);
  const [fixKey, setFixKey] = useState<string | null>(null);
  const [loadingFix, setLoadingFix] = useState(false);
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<Array<{ date: string; score: number }>>([]);
  const [schedule, setSchedule] = useState('weekly');
  const [savingSchedule, setSavingSchedule] = useState(false);

  const load = async () => {
    try {
      const [latest, hist, sched] = await Promise.all([
        geoReadinessApi.latest(siteId),
        geoReadinessApi.history(siteId).catch(() => ({ points: [] })),
        geoReadinessApi.getSchedule(siteId).catch(() => ({ frequency: 'weekly', enabled: true })),
      ]);
      setData(latest);
      setHistory(hist.points);
      setSchedule(sched.frequency);
    } catch (e) {
      report(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  const runCheck = async () => {
    setChecking(true);
    try {
      const res: GeoReadinessResult = await geoReadinessApi.run(siteId);
      setData({ score: res.score, checks: res.checks, checked_at: res.checkedAt });
      const hist = await geoReadinessApi.history(siteId).catch(() => ({ points: [] }));
      setHistory(hist.points);
    } catch (e) {
      report(e);
    } finally {
      setChecking(false);
    }
  };

  const showFix = async (fixType: string) => {
    setLoadingFix(true);
    setFixKey(fixType);
    try {
      const res = await geoReadinessApi.fixes(siteId, fixType);
      if (res.fix) setFix(res.fix);
    } catch (e) {
      report(e);
    } finally {
      setLoadingFix(false);
    }
  };

  const copyFix = async () => {
    if (!fix) return;
    try {
      await navigator.clipboard.writeText(fix.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — user can select manually
    }
  };

  const saveSchedule = async (freq: 'daily' | 'weekly') => {
    setSavingSchedule(true);
    try {
      await geoReadinessApi.schedule(siteId, freq);
      setSchedule(freq);
    } catch (e) {
      report(e);
    } finally {
      setSavingSchedule(false);
    }
  };

  if (loading) return <p className="font-mono text-sm text-white/55">Loading AI readiness…</p>;

  const failedChecks = (data?.checks ?? []).filter((c) => !c.passed);

  return (
    <div className="space-y-6">
      <div className="bx-card bx-glow">
        <p className="bx-micro mb-3">~/ ai readiness — free check</p>
        <ScoreGauge score={data?.score ?? null} label="AI readiness score" />
        <p className="mt-3 text-sm text-white/70">
          {data?.score === null || data?.score === undefined
            ? 'Abhi tak check nahi hua. Neeche "Check karo" dabayein — AI tumhari site ko dekhega ya nahi, ye pata chalega.'
            : data.score >= 80
              ? 'Zabardast! AI assistants tumhari site ko samajhte hain aur tumhara naam lenge.'
              : data.score >= 50
                ? 'Kaam chal raha hai, lekin AI aksar tumhe miss kar dega. Neeche failed checks fix karo.'
                : 'Khatra! AI ko tumhari site nazar nahi aa rahi. Neeche har failed check ke saath Fix button hai.'}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button onClick={runCheck} disabled={checking} className="bx-btn-primary">
            {checking ? 'Check ho raha hai…' : data?.score == null ? 'Check karo' : 'Dobara check karo'}
          </button>
          <label className="flex items-center gap-2 text-xs text-white/55">
            Auto-check:
            <select
              value={schedule}
              disabled={savingSchedule}
              onChange={(e) => saveSchedule(e.target.value as 'daily' | 'weekly')}
              className="bx-input !w-auto !py-1 text-xs"
            >
              <option value="weekly">Weekly</option>
              <option value="daily">Daily</option>
            </select>
          </label>
        </div>
        {data?.checked_at && (
          <p className="mt-2 font-mono text-[11px] text-white/40">
            Last check: {new Date(data.checked_at).toLocaleString()}
          </p>
        )}
      </div>

      {(data?.checks ?? []).length > 0 && (
        <div className="bx-card">
          <p className="bx-micro mb-1">~/ checklist</p>
          <h3 className="mb-3 text-sm font-semibold text-white">AI readiness checklist</h3>
          <ul className="space-y-3">
            {data!.checks.map((c) => (
              <li key={c.key} className="flex items-start justify-between gap-3 rounded-lg border border-white/10 p-3">
                <div className="flex items-start gap-3">
                  <span className={`mt-0.5 text-lg ${c.passed ? 'text-teal-300' : 'text-red-300'}`}>
                    {c.passed ? '✅' : '❌'}
                  </span>
                  <div>
                    <p className="text-sm font-medium text-white">
                      {c.label} <span className="font-mono text-xs text-white/40">({c.points}/{c.maxPoints})</span>
                    </p>
                    <p className="mt-1 text-xs text-white/60">{c.detail}</p>
                    {!c.passed && <p className="mt-1 text-xs text-amber-200/80">{c.fixHint}</p>}
                  </div>
                </div>
                {!c.passed && c.key !== 'definition_content' && (
                  <button
                    onClick={() => showFix(c.key)}
                    disabled={loadingFix && fixKey === c.key}
                    className="bx-btn-secondary shrink-0 !px-3 !py-1.5 text-xs"
                  >
                    {loadingFix && fixKey === c.key ? '…' : 'Fix dikhao'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {fix && (
        <div className="bx-card border-teal-400/30">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">{fix.title}</h3>
            <button onClick={() => setFix(null)} className="text-xs text-white/55 hover:text-white">✕ Band karo</button>
          </div>
          <pre className="max-h-80 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-xs text-white/80">{fix.content}</pre>
          <div className="mt-3 flex gap-2">
            <button onClick={copyFix} className="bx-btn-primary !px-4 !py-1.5 text-xs">
              {copied ? '✓ Copy ho gaya!' : 'Copy karo'}
            </button>
          </div>
          <p className="mt-2 text-xs text-white/55">
            {fix.contentKind === 'file'
              ? 'Ye text copy karke apni site pe file banake lagayein (jese llms.txt site ke root me).'
              : 'Ye code copy karke apni site ke homepage ke <head> me lagayein.'}
          </p>
        </div>
      )}

      {history.length > 1 && (
        <div className="bx-card">
          <p className="bx-micro mb-1">~/ progress</p>
          <h3 className="mb-3 text-sm font-semibold text-white">Score history</h3>
          <div className="flex items-end gap-1" style={{ height: 80 }}>
            {history.slice(-30).map((p) => (
              <div key={p.date} className="flex-1" title={`${p.date}: ${p.score}`}>
                <div
                  className={`rounded-t ${p.score >= 80 ? 'bg-teal-400/70' : p.score >= 50 ? 'bg-amber-400/70' : 'bg-red-400/70'}`}
                  style={{ height: `${Math.max(4, p.score * 0.8)}px` }}
                />
              </div>
            ))}
          </div>
          <p className="mt-2 font-mono text-[11px] text-white/40">
            {history[0]?.date} → {history[history.length - 1]?.date} · {failedChecks.length} cheezein baqi hain
          </p>
        </div>
      )}
    </div>
  );
}
