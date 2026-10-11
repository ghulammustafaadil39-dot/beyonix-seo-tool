'use client';

import { useEffect, useState } from 'react';
import { withMockFallback, notLandedYet } from '@/lib/mock';
import {
  mockWhiteLabel,
  mockSchedules,
  mockShareLink,
  type WhiteLabel,
  type ReportSchedule,
} from '@/lib/mock/reports';
import MockBanner from '@/components/MockBanner';

/**
 * F-08 — Reporting v2 UI extras: white-label branding, scheduled email
 * delivery, client share links. Mock-backed (bannered) until endpoints land.
 */
export default function ReportsV2Panel({ siteId }: { siteId: string }) {
  const [wl, setWl] = useState<WhiteLabel | null>(null);
  const [schedules, setSchedules] = useState<ReportSchedule[]>([]);
  const [saved, setSaved] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [shareBusy, setShareBusy] = useState(false);
  const [newRecipient, setNewRecipient] = useState('');

  useEffect(() => {
    (async () => {
      const [w, s] = await Promise.all([
        withMockFallback(() => notLandedYet<WhiteLabel>(), mockWhiteLabel),
        withMockFallback(() => notLandedYet<ReportSchedule[]>(), mockSchedules),
      ]);
      setWl(w.data);
      setSchedules(s.data);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  const saveWhiteLabel = () => {
    // PATCH /settings/white-label pending — local state only.
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const addSchedule = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newRecipient)) return;
    setSchedules((prev) => [
      ...prev,
      {
        id: `local_${Date.now()}`,
        frequency: 'weekly',
        recipients: [newRecipient],
        next_run: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        enabled: true,
      },
    ]);
    setNewRecipient('');
  };

  const toggleSchedule = (id: string) =>
    setSchedules((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));

  const createShareLink = async () => {
    setShareBusy(true);
    try {
      const { data } = await withMockFallback(
        () => notLandedYet<{ share_url: string }>(),
        () => mockShareLink('latest'),
      );
      setShareUrl(data.share_url);
    } finally {
      setShareBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div><MockBanner label="white-label reports" /></div>

      {/* White-label */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ white label</p>
        <h3 className="text-base font-bold text-white">Report branding</h3>
        <p className="bx-body mt-1">
          Reports go out under your brand — your logo, your colors.
        </p>
        {wl && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="wl-company" className="bx-label">Company name</label>
              <input
                id="wl-company"
                value={wl.company_name}
                onChange={(e) => setWl({ ...wl, company_name: e.target.value })}
                className="bx-input"
              />
            </div>
            <div>
              <label htmlFor="wl-color" className="bx-label">Primary color</label>
              <div className="flex gap-2">
                <input
                  id="wl-color"
                  type="color"
                  value={wl.primary_color}
                  onChange={(e) => setWl({ ...wl, primary_color: e.target.value })}
                  className="h-10 w-14 cursor-pointer rounded-lg border border-white/10 bg-white/5"
                  aria-label="Primary brand color"
                />
                <input
                  value={wl.primary_color}
                  onChange={(e) => setWl({ ...wl, primary_color: e.target.value })}
                  className="bx-input font-mono"
                  aria-label="Primary brand color hex"
                />
              </div>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="wl-footer" className="bx-label">Report footer text</label>
              <input
                id="wl-footer"
                value={wl.footer_text}
                onChange={(e) => setWl({ ...wl, footer_text: e.target.value })}
                className="bx-input"
              />
            </div>
          </div>
        )}
        {/* Live preview */}
        {wl && (
          <div className="mt-4 rounded-lg border border-white/10 p-4" aria-label="Report preview">
            <div className="flex items-center gap-3 border-b border-white/10 pb-3">
              <span
                className="flex h-9 w-9 items-center justify-center rounded-lg font-bold text-white"
                style={{ backgroundColor: wl.primary_color }}
                aria-hidden="true"
              >
                {wl.company_name.charAt(0)}
              </span>
              <div>
                <p className="text-sm font-bold text-white">{wl.company_name}</p>
                <p className="font-mono text-xs text-white/40">Weekly SEO report — example.com</p>
              </div>
            </div>
            <p className="mt-3 text-xs text-white/60">
              Executive summary, score trends, and top actions — in plain language.
            </p>
            <p className="mt-3 border-t border-white/10 pt-3 font-mono text-[11px] text-white/30">
              {wl.footer_text}
            </p>
          </div>
        )}
        <button onClick={saveWhiteLabel} className="bx-btn-primary mt-4">
          {saved ? 'Saved ✓ (server sync pending)' : 'Save branding'}
        </button>
      </div>

      {/* Schedules + share */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="bx-card">
          <p className="bx-micro mb-1">~/ schedules</p>
          <h3 className="text-base font-bold text-white">Scheduled delivery</h3>
          <ul className="mt-3 space-y-2">
            {schedules.map((s) => (
              <li key={s.id} className="bx-panel flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium capitalize text-white">{s.frequency} report</p>
                  <p className="font-mono text-xs text-white/40">
                    to {s.recipients.join(', ')} · next {new Date(s.next_run).toLocaleDateString()}
                  </p>
                </div>
                <button
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={`Toggle ${s.frequency} report schedule`}
                  onClick={() => toggleSchedule(s.id)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${s.enabled ? 'bg-teal-400' : 'bg-white/15'}`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${s.enabled ? 'left-[22px]' : 'left-0.5'}`}
                  />
                </button>
              </li>
            ))}
          </ul>
          <form onSubmit={addSchedule} className="mt-3 flex gap-2">
            <input
              type="email"
              value={newRecipient}
              onChange={(e) => setNewRecipient(e.target.value)}
              placeholder="client@company.com"
              className="bx-input"
              aria-label="Recipient email for weekly report"
            />
            <button type="submit" className="bx-btn-secondary shrink-0 !text-xs">
              Add weekly
            </button>
          </form>
        </div>
        <div className="bx-card">
          <p className="bx-micro mb-1">~/ share</p>
          <h3 className="text-base font-bold text-white">Client share link</h3>
          <p className="bx-body mt-1">
            A read-only link to the latest report — no login needed.
          </p>
          <button onClick={createShareLink} disabled={shareBusy} className="bx-btn-primary mt-3">
            {shareBusy ? 'Creating…' : 'Create share link'}
          </button>
          {shareUrl && (
            <div className="mt-3 flex items-center gap-2">
              <input readOnly value={shareUrl} className="bx-input font-mono !text-xs" aria-label="Client share link" />
              <button
                onClick={() => navigator.clipboard.writeText(shareUrl).catch(() => {})}
                className="bx-btn-xs-secondary"
              >
                Copy
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
