'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  reportsApi,
  reportsV2Api,
  REPORT_SECTIONS,
  type Report,
  type ReportComparison,
  type ReportSchedule,
  type ShareLink,
  type TenantBranding,
} from '@/lib/api';

/**
 * F-08 — White-label reports v2 (WIRED, Wave 2 round 2): branding CRUD,
 * report build with section select, PDF/HTML download, period comparison,
 * share create/list/revoke, and schedule CRUD (single per-site schedule —
 * the backend stores one row per site, upserted via PUT).
 * NOTE: branding has NO footer_text field in the backend; the old mock's
 * footer input was dropped (flagged in the wiring report).
 */
export default function ReportsV2Panel({ siteId }: { siteId: string }) {
  const [branding, setBranding] = useState<TenantBranding>({
    company_name: '', logo_url: '', primary_color: '#0d9488', accent_color: '#22d3ee',
  });
  const [reports, setReports] = useState<Report[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [sections, setSections] = useState<string[]>([...REPORT_SECTIONS]);
  const [periodDays, setPeriodDays] = useState(7);
  const [compare, setCompare] = useState<ReportComparison | null>(null);
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [shareUrl, setShareUrl] = useState('');
  const [schedule, setSchedule] = useState<ReportSchedule | null>(null);
  const [schedFreq, setSchedFreq] = useState<'weekly' | 'monthly'>('weekly');
  const [schedRecipients, setSchedRecipients] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const loadShares = useCallback(async (reportId: string) => {
    if (!reportId) return;
    try {
      const res = await reportsV2Api.listShares(reportId);
      setShares(res.data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load share links.');
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const [b, r, s] = await Promise.all([
        reportsV2Api.branding(),
        reportsApi.list(siteId),
        reportsV2Api.schedule(siteId),
      ]);
      setBranding({
        company_name: b.company_name ?? '',
        logo_url: b.logo_url ?? '',
        primary_color: b.primary_color ?? '#0d9488',
        accent_color: b.accent_color ?? '#22d3ee',
      });
      setReports(r.data);
      if (r.data.length > 0) setSelectedId((prev) => prev || r.data[0].id);
      setSchedule(s.schedule);
      if (s.schedule) {
        setSchedFreq(s.schedule.frequency);
        setSchedRecipients(s.schedule.recipients.join(', '));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load reports v2 data.');
    }
  }, [siteId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setCompare(null);
    setShareUrl('');
    if (selectedId) loadShares(selectedId);
  }, [selectedId, loadShares]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setErr('');
    setMsg('');
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy('');
    }
  };

  const saveBranding = () =>
    act('branding', async () => {
      const res = await reportsV2Api.saveBranding({
        company_name: branding.company_name || undefined,
        logo_url: branding.logo_url || undefined,
        primary_color: branding.primary_color || undefined,
        accent_color: branding.accent_color || undefined,
      });
      setBranding({
        company_name: res.company_name ?? '', logo_url: res.logo_url ?? '',
        primary_color: res.primary_color ?? '#0d9488', accent_color: res.accent_color ?? '#22d3ee',
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    });

  const build = () =>
    act('build', async () => {
      const rep = await reportsV2Api.build(siteId, sections, periodDays);
      setMsg(`Report built for ${new Date(rep.period_start).toLocaleDateString()} — ${new Date(rep.period_end).toLocaleDateString()}.`);
      await load();
      setSelectedId(rep.id);
    });

  const toggleSection = (s: string) =>
    setSections((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const runCompare = () =>
    act('compare', async () => setCompare(await reportsV2Api.compare(selectedId)));

  const createShare = () =>
    act('share', async () => {
      const created = await reportsV2Api.createShare(selectedId, 30);
      setShareUrl(created.url);
      await loadShares(selectedId);
    });

  const revokeShare = (tokenId: string) =>
    act(tokenId, async () => {
      await reportsV2Api.revokeShare(selectedId, tokenId);
      setShares((prev) => prev.filter((s) => s.id !== tokenId));
    });

  const saveSchedule = () =>
    act('schedule', async () => {
      const recipients = schedRecipients.split(',').map((x) => x.trim()).filter(Boolean);
      const res = await reportsV2Api.saveSchedule(siteId, {
        frequency: schedFreq,
        ...(recipients.length ? { recipients } : {}),
        sections,
        enabled: schedule?.enabled ?? true,
      });
      setSchedule(res.schedule);
      setMsg('Schedule saved.');
    });

  const toggleScheduleEnabled = () =>
    act('schedule-toggle', async () => {
      if (!schedule) return;
      const res = await reportsV2Api.saveSchedule(siteId, { enabled: !schedule.enabled });
      setSchedule(res.schedule);
    });

  const deleteSchedule = () =>
    act('schedule-delete', async () => {
      await reportsV2Api.deleteSchedule(siteId);
      setSchedule(null);
      setMsg('Schedule deleted.');
    });

  const delta = (label: string, v: number | null, invert = false) =>
    v === null ? (
      <div key={label} className="flex justify-between text-sm"><dt className="text-white/60">{label}</dt><dd className="font-mono text-white/55">n/a</dd></div>
    ) : (
      <div key={label} className="flex justify-between text-sm">
        <dt className="text-white/60">{label}</dt>
        <dd className={`font-mono font-medium ${v === 0 ? 'text-white/60' : (v > 0) !== invert ? 'text-teal-300' : 'text-red-300'}`}>
          {v > 0 ? '+' : ''}{v}
        </dd>
      </div>
    );

  return (
    <div className="space-y-6">
      {err && <p className="bx-alert-err" role="alert">{err}</p>}
      {msg && <p className="bx-alert-ok">{msg}</p>}

      {/* Branding CRUD */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ white label</p>
        <h3 className="text-base font-bold text-white">Report branding</h3>
        <p className="bx-body mt-1">Reports go out under your brand — your logo, your colors.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="wl-company" className="bx-label">Company name</label>
            <input id="wl-company" value={branding.company_name ?? ''} onChange={(e) => setBranding({ ...branding, company_name: e.target.value })} className="bx-input" />
          </div>
          <div>
            <label htmlFor="wl-logo" className="bx-label">Logo URL (https)</label>
            <input id="wl-logo" value={branding.logo_url ?? ''} onChange={(e) => setBranding({ ...branding, logo_url: e.target.value })} className="bx-input font-mono" placeholder="https://…" />
          </div>
          {(['primary_color', 'accent_color'] as const).map((f) => (
            <div key={f}>
              <label htmlFor={`wl-${f}`} className="bx-label">{f === 'primary_color' ? 'Primary color' : 'Accent color'}</label>
              <div className="flex gap-2">
                <input id={`wl-${f}`} type="color" value={branding[f] ?? '#0d9488'} onChange={(e) => setBranding({ ...branding, [f]: e.target.value })} className="h-10 w-14 cursor-pointer rounded-lg border border-white/10 bg-white/5" aria-label={f} />
                <input value={branding[f] ?? ''} onChange={(e) => setBranding({ ...branding, [f]: e.target.value })} className="bx-input font-mono" aria-label={`${f} hex`} />
              </div>
            </div>
          ))}
        </div>
        {/* Live preview */}
        <div className="mt-4 rounded-lg border border-white/10 p-4" aria-label="Report preview">
          <div className="flex items-center gap-3 border-b border-white/10 pb-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg font-bold text-white" style={{ backgroundColor: branding.primary_color ?? '#0d9488' }} aria-hidden="true">
              {(branding.company_name || 'B').charAt(0)}
            </span>
            <div>
              <p className="text-sm font-bold text-white">{branding.company_name || 'Your company'}</p>
              <p className="font-mono text-xs text-white/55">Weekly SEO report</p>
            </div>
          </div>
          <p className="mt-3 text-xs text-white/60">Executive summary, score trends, and top actions — in plain language.</p>
        </div>
        <button onClick={saveBranding} disabled={busy === 'branding'} className="bx-btn-primary mt-4">
          {busy === 'branding' ? 'Saving…' : saved ? 'Saved ✓' : 'Save branding'}
        </button>
      </div>

      {/* Build + download + compare + share */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ build &amp; share</p>
        <h3 className="text-base font-bold text-white">Build a branded report</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {REPORT_SECTIONS.map((s) => (
            <button key={s} onClick={() => toggleSection(s)} aria-pressed={sections.includes(s)} className={sections.includes(s) ? 'bx-btn-primary !text-xs' : 'bx-btn-secondary !text-xs'}>
              {s}
            </button>
          ))}
          <select value={periodDays} onChange={(e) => setPeriodDays(Number(e.target.value))} className="bx-input !w-auto !text-xs" aria-label="Report period in days">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button onClick={build} disabled={busy === 'build' || sections.length === 0} className="bx-btn-primary !text-xs">
            {busy === 'build' ? 'Building…' : 'Build report'}
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className="bx-input !w-auto !text-xs" aria-label="Report for download/share">
            {reports.map((r) => (
              <option key={r.id} value={r.id}>
                {new Date(r.period_start).toLocaleDateString()} — {new Date(r.period_end).toLocaleDateString()}
              </option>
            ))}
            {reports.length === 0 && <option value="">No reports yet</option>}
          </select>
          {selectedId && <a href={reportsV2Api.pdfUrl(selectedId)} className="bx-btn-secondary !text-xs">Download PDF</a>}
          {selectedId && <a href={reportsV2Api.htmlUrl(selectedId)} target="_blank" rel="noreferrer" className="bx-btn-secondary !text-xs">View HTML</a>}
          {selectedId && (
            <button onClick={runCompare} disabled={busy === 'compare'} className="bx-btn-secondary !text-xs">
              {busy === 'compare' ? 'Comparing…' : 'Compare vs previous'}
            </button>
          )}
          {selectedId && (
            <button onClick={createShare} disabled={busy === 'share'} className="bx-btn-secondary !text-xs">
              {busy === 'share' ? 'Creating…' : 'Create share link'}
            </button>
          )}
        </div>

        {compare && (
          <dl className="bx-panel mt-4 space-y-1">
            {delta('Audit score', compare.deltas.auditScore)}
            {delta('Open errors (reduction is good)', compare.deltas.openErrors, true)}
            {delta('Keywords improved', compare.deltas.keywordsImproved)}
            {delta('AI visibility (simulated)', compare.deltas.geoScore)}
            {!compare.previous && <p className="text-xs text-white/55">No previous report — deltas need two reports.</p>}
          </dl>
        )}

        {shareUrl && (
          <div className="mt-3 flex items-center gap-2">
            <input readOnly value={shareUrl} className="bx-input font-mono !text-xs" aria-label="Client share link" />
            <button onClick={() => navigator.clipboard.writeText(shareUrl).catch(() => {})} className="bx-btn-xs-secondary">Copy</button>
          </div>
        )}
        {shares.length > 0 && (
          <ul className="mt-3 space-y-2">
            {shares.map((s) => (
              <li key={s.id} className="bx-panel flex items-center justify-between gap-3">
                <span className="font-mono text-xs text-white/50">
                  shared {new Date(s.created_at).toLocaleDateString()} · expires {new Date(s.expires_at).toLocaleDateString()}
                </span>
                <button onClick={() => revokeShare(s.id)} disabled={busy === s.id} className="text-xs text-red-300/80 hover:text-red-300 hover:underline">
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Schedule CRUD (one per site) */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ schedules</p>
        <h3 className="text-base font-bold text-white">Scheduled delivery</h3>
        {schedule ? (
          <div className="bx-panel mt-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium capitalize text-white">{schedule.frequency} report</p>
              <p className="font-mono text-xs text-white/55">
                to {schedule.recipients.length ? schedule.recipients.join(', ') : '—'}
                {schedule.sections?.length ? ` · sections: ${schedule.sections.join(', ')}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button role="switch" aria-checked={schedule.enabled} aria-label="Toggle report schedule" onClick={toggleScheduleEnabled} className={`relative h-6 w-11 shrink-0 rounded-full transition ${schedule.enabled ? 'bg-teal-400' : 'bg-white/15'}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${schedule.enabled ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
              <button onClick={deleteSchedule} disabled={busy === 'schedule-delete'} className="text-xs text-red-300/80 hover:text-red-300 hover:underline">Delete</button>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-white/55">No schedule for this site yet — create one below.</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <select value={schedFreq} onChange={(e) => setSchedFreq(e.target.value as 'weekly' | 'monthly')} className="bx-input !w-auto" aria-label="Schedule frequency">
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
          <input value={schedRecipients} onChange={(e) => setSchedRecipients(e.target.value)} placeholder="client@company.com, team@company.com" className="bx-input flex-1" aria-label="Schedule recipients (comma-separated emails)" />
          <button onClick={saveSchedule} disabled={busy === 'schedule'} className="bx-btn-secondary shrink-0 !text-xs">
            {busy === 'schedule' ? 'Saving…' : schedule ? 'Update schedule' : 'Create schedule'}
          </button>
        </div>
      </div>
    </div>
  );
}
