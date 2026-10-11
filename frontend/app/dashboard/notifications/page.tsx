'use client';

import { useEffect, useState } from 'react';
import { withMockFallback, notLandedYet } from '@/lib/mock';
import {
  mockRules,
  mockNotifications,
  mockDigest,
  type AlertRule,
  type AppNotification,
  type DigestSettings,
  type Channel,
} from '@/lib/mock/notifications';
import { useErrorReporter } from '@/components/ErrorBanner';
import MockBanner from '@/components/MockBanner';

const CHANNELS: Channel[] = ['email', 'telegram', 'slack', 'webhook'];

const SEVERITY_PILL: Record<string, string> = {
  info: 'bx-pill-info',
  warning: 'bx-pill-warn',
  critical: 'bx-pill-err',
};

/**
 * F-10 — Notifications: per-user alert rules (rank drop, critical issue,
 * site down, limit near, report ready), channel configuration, digest
 * settings, and the in-app notification center.
 * Mock-backed (bannered) except notify_email/telegram which use real settings.
 */
export default function NotificationsPage() {
  const { report } = useErrorReporter();
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [notes, setNotes] = useState<AppNotification[]>([]);
  const [digest, setDigest] = useState<DigestSettings | null>(null);
  const [slackUrl, setSlackUrl] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [r, n, d] = await Promise.all([
          withMockFallback(() => notLandedYet<AlertRule[]>(), mockRules),
          withMockFallback(() => notLandedYet<AppNotification[]>(), mockNotifications),
          withMockFallback(() => notLandedYet<DigestSettings>(), mockDigest),
        ]);
        setRules(r.data);
        setNotes(n.data);
        setDigest(d.data);
      } catch (e) {
        report(e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleRule = (id: string) =>
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));

  const toggleChannel = (id: string, ch: Channel) =>
    setRules((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              channels: r.channels.includes(ch)
                ? r.channels.filter((c) => c !== ch)
                : [...r.channels, ch],
            }
          : r,
      ),
    );

  const markAllRead = () => setNotes((prev) => prev.map((n) => ({ ...n, read: true })));

  const saveChannels = () => {
    // Slack/webhook storage endpoint pending — local only.
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const unread = notes.filter((n) => !n.read).length;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="bx-micro mb-1">~/ notifications</p>
        <h1 className="bx-h1">Notifications</h1>
      </div>
      <div><MockBanner label="alert rules & notification center" /></div>

      {/* Alert rules */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ alert rules</p>
        <h2 className="text-base font-bold text-white">Alert rules</h2>
        <div className="mt-3 space-y-2">
          {rules.map((r) => (
            <div key={r.id} className="bx-panel">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-white">{r.label}</p>
                  <p className="font-mono text-xs text-white/40">threshold: {r.threshold}</p>
                </div>
                <button
                  role="switch"
                  aria-checked={r.enabled}
                  aria-label={`Toggle rule: ${r.label}`}
                  onClick={() => toggleRule(r.id)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${r.enabled ? 'bg-teal-400' : 'bg-white/15'}`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${r.enabled ? 'left-[22px]' : 'left-0.5'}`}
                  />
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={`Channels for ${r.label}`}>
                {CHANNELS.map((ch) => (
                  <button
                    key={ch}
                    onClick={() => toggleChannel(r.id, ch)}
                    aria-pressed={r.channels.includes(ch)}
                    disabled={!r.enabled}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium transition disabled:opacity-40 ${
                      r.channels.includes(ch)
                        ? 'border-teal-400/40 bg-teal-400/10 text-teal-300'
                        : 'border-white/10 bg-white/5 text-white/50'
                    }`}
                  >
                    {ch}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Channels */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ channels</p>
        <h2 className="text-base font-bold text-white">Channels</h2>
        <p className="bx-body mt-1">
          Email and Telegram are configured in <a className="bx-link" href="/dashboard/settings">Settings</a>.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="slack-url" className="bx-label">Slack webhook URL</label>
            <input
              id="slack-url"
              type="url"
              value={slackUrl}
              onChange={(e) => setSlackUrl(e.target.value)}
              placeholder="https://hooks.slack.com/…"
              className="bx-input font-mono"
            />
          </div>
          <div>
            <label htmlFor="webhook-url" className="bx-label">Generic webhook URL</label>
            <input
              id="webhook-url"
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://your-app.com/hooks/seo"
              className="bx-input font-mono"
            />
          </div>
        </div>
        <button onClick={saveChannels} className="bx-btn-primary mt-4">
          {saved ? 'Saved ✓ (server sync pending)' : 'Save channels'}
        </button>

        {digest && (
          <div className="mt-6 border-t border-white/10 pt-4">
            <p className="text-sm font-semibold text-white">Digest</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button
                role="switch"
                aria-checked={digest.enabled}
                aria-label="Toggle digest emails"
                onClick={() => setDigest({ ...digest, enabled: !digest.enabled })}
                className={`relative h-6 w-11 rounded-full transition ${digest.enabled ? 'bg-teal-400' : 'bg-white/15'}`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${digest.enabled ? 'left-[22px]' : 'left-0.5'}`}
                />
              </button>
              <select
                value={digest.frequency}
                onChange={(e) => setDigest({ ...digest, frequency: e.target.value as 'daily' | 'weekly' })}
                className="bx-input !w-auto"
                aria-label="Digest frequency"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
              <span className="text-xs text-white/40">summary email</span>
            </div>
          </div>
        )}
      </div>

      {/* In-app center */}
      <div className="bx-card">
        <div className="flex items-center justify-between">
          <div>
            <p className="bx-micro mb-1">~/ inbox</p>
            <h2 className="text-base font-bold text-white">
              Notification center{' '}
              {unread > 0 && (
                <span className="bx-pill bx-pill-warn ml-2">
                  <span className="bx-dot" />
                  {unread} unread
                </span>
              )}
            </h2>
          </div>
          <button onClick={markAllRead} className="bx-btn-xs-secondary">
            Mark all read
          </button>
        </div>
        <ul className="mt-3 space-y-2">
          {notes.map((n) => (
            <li
              key={n.id}
              className={`bx-panel flex items-start justify-between gap-3 ${n.read ? 'opacity-60' : ''}`}
            >
              <div>
                <p className="flex items-center gap-2 text-sm font-medium text-white">
                  <span className={`bx-pill ${SEVERITY_PILL[n.severity]}`}>
                    <span className="bx-dot" />
                    {n.severity}
                  </span>
                  {n.title}
                </p>
                <p className="mt-1 text-xs text-white/55">{n.detail}</p>
              </div>
              <span className="shrink-0 font-mono text-[11px] text-white/30">
                {new Date(n.at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
