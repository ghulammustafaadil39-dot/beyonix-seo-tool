'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  notificationsApi,
  webhooksApi,
  type AlertRule,
  type AlertRuleType,
  type DigestSettings,
  type NotificationLogEntry,
  type NotifyChannel,
  type WebhookDelivery,
  type WebhookEndpoint,
} from '@/lib/api';
import { useErrorReporter } from '@/components/ErrorBanner';

const CHANNELS: NotifyChannel[] = ['email', 'telegram', 'slack', 'webhook', 'inapp'];

const RULE_META: Record<AlertRuleType, { label: string; hint: string }> = {
  rank_drop: { label: 'Keyword drops significantly', hint: 'Fires when a tracked keyword falls by the configured number of positions.' },
  critical_issue: { label: 'New critical audit issue', hint: 'Fires when a crawl finds a critical (error-severity) issue.' },
  site_down: { label: 'Site unreachable during crawl', hint: 'Fires when the crawler cannot reach the site.' },
  limit_near: { label: 'Plan limit nearly reached', hint: 'Fires at 80% and 100% of a plan usage limit.' },
};
const RULE_TYPES = Object.keys(RULE_META) as AlertRuleType[];

/** Fallback catalog mirrors backend WEBHOOK_EVENT_CATALOG (routes/webhooks.ts);
 *  the live list is fetched from GET /api/v1/webhooks/events when possible. */
const FALLBACK_EVENTS = [
  'audit.completed',
  'rank.changed',
  'report.ready',
  'invoice.paid',
  'invoice.payment_failed',
  'subscription.updated',
  'limit.near',
  'site.down',
  'issue.critical',
  'notify.rank_drop',
  'notify.critical_issue',
  'notify.site_down',
  'notify.limit_near',
];

interface RuleDraft {
  id: string | null; // null = not created on the server yet
  channels: NotifyChannel[];
  config: Record<string, unknown>;
  enabled: boolean;
}

function draftFrom(rule: AlertRule | undefined): RuleDraft {
  if (!rule) return { id: null, channels: ['email'], config: {}, enabled: false };
  return { id: rule.id, channels: rule.channels, config: rule.config ?? {}, enabled: rule.enabled };
}

const LOG_PILL: Record<string, string> = {
  sent: 'bx-pill-ok',
  failed: 'bx-pill-err',
  skipped: 'bx-pill-info',
};
const DELIVERY_PILL: Record<string, string> = {
  delivered: 'bx-pill-ok',
  pending: 'bx-pill-warn',
  failed: 'bx-pill-err',
};

/**
 * F-10 — Notifications (WIRED, Wave 2): per-user alert rules, digest
 * settings, outbound webhook endpoints + deliveries, and the delivery
 * log — all real, from /api/v1/account/* and /api/v1/webhooks/*.
 * The backend log has no read/unread state, so none is shown.
 */
export default function NotificationsPage() {
  const { report } = useErrorReporter();
  const [drafts, setDrafts] = useState<Record<AlertRuleType, RuleDraft> | null>(null);
  const [digest, setDigest] = useState<DigestSettings | null>(null);
  const [log, setLog] = useState<NotificationLogEntry[] | null>(null);
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [catalog, setCatalog] = useState<string[]>(FALLBACK_EVENTS);
  const [hookUrl, setHookUrl] = useState('');
  const [hookEvents, setHookEvents] = useState<string[]>(['audit.completed']);
  const [hookBusy, setHookBusy] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [slackDrafts, setSlackDrafts] = useState<Partial<Record<AlertRuleType, string>>>({});
  const [savedFlash, setSavedFlash] = useState('');

  const flash = (msg: string) => {
    setSavedFlash(msg);
    setTimeout(() => setSavedFlash(''), 2500);
  };

  const loadDeliveries = useCallback(async () => {
    const d = await webhooksApi.deliveries().catch(() => null);
    if (d) setDeliveries(d.data);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [rulesRes, digestRes, logRes, epRes, catRes] = await Promise.allSettled([
          notificationsApi.rules(),
          notificationsApi.digest(),
          notificationsApi.log(),
          webhooksApi.list(),
          webhooksApi.eventCatalog(),
        ]);
        if (rulesRes.status === 'fulfilled') {
          const byType = {} as Record<AlertRuleType, RuleDraft>;
          for (const t of RULE_TYPES) {
            byType[t] = draftFrom(rulesRes.value.data.find((r) => r.rule_type === t));
          }
          setDrafts(byType);
        } else report(rulesRes.reason);
        if (digestRes.status === 'fulfilled') setDigest(digestRes.value);
        else report(digestRes.reason);
        if (logRes.status === 'fulfilled') setLog(logRes.value.data);
        else report(logRes.reason);
        if (epRes.status === 'fulfilled') setEndpoints(epRes.value.data);
        else report(epRes.reason);
        if (catRes.status === 'fulfilled' && catRes.value.events.length > 0) {
          setCatalog(catRes.value.events);
        }
        await loadDeliveries();
      } catch (e) {
        report(e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveRule = async (type: AlertRuleType, draft: RuleDraft) => {
    try {
      const saved = await notificationsApi.upsertRule({
        ruleType: type,
        channels: draft.channels.length > 0 ? draft.channels : ['inapp'],
        config: draft.config,
        enabled: draft.enabled,
      });
      setDrafts((prev) =>
        prev ? { ...prev, [type]: draftFrom(saved) } : prev,
      );
      flash('Alert rule saved.');
    } catch (e) {
      report(e);
      // Re-sync from the server so the UI never shows unsaved state as saved.
      const res = await notificationsApi.rules().catch(() => null);
      if (res) {
        setDrafts((prev) => {
          if (!prev) return prev;
          const next = { ...prev };
          next[type] = draftFrom(res.data.find((r) => r.rule_type === type));
          return next;
        });
      }
    }
  };

  const patchDraft = (type: AlertRuleType, patch: Partial<RuleDraft>, save = true) => {
    setDrafts((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [type]: { ...prev[type], ...patch } };
      if (save) void saveRule(type, next[type]);
      return next;
    });
  };

  const toggleChannel = (type: AlertRuleType, ch: NotifyChannel) => {
    if (!drafts) return;
    const draft = drafts[type];
    if (ch === 'slack' && !draft.channels.includes('slack')) {
      // Backend requires config.slack_webhook_url for the slack channel;
      // collect it inline first (see the slack URL field under the rule).
      patchDraft(type, { channels: [...draft.channels, 'slack'] }, false);
      return;
    }
    const removing = draft.channels.includes(ch);
    const channels = removing
      ? draft.channels.filter((c) => c !== ch)
      : [...draft.channels, ch];
    // C3-L4: when the slack channel is removed, also drop the stored webhook
    // URL so a stale secret is not retained server-side (the API has no
    // dedicated clear endpoint — it upserts config as-is, and omitting the
    // key clears it). If slack is re-enabled later the URL field is collected
    // fresh (see saveSlackUrl).
    const config =
      ch === 'slack' && removing
        ? Object.fromEntries(Object.entries(draft.config).filter(([k]) => k !== 'slack_webhook_url'))
        : draft.config;
    patchDraft(type, { channels, config });
  };

  const saveSlackUrl = (type: AlertRuleType) => {
    if (!drafts) return;
    const url = (slackDrafts[type] ?? '').trim();
    if (!url) return;
    patchDraft(type, {
      config: { ...drafts[type].config, slack_webhook_url: url },
    });
  };

  const deleteRule = async (type: AlertRuleType) => {
    const draft = drafts?.[type];
    if (!draft?.id) return;
    try {
      await notificationsApi.deleteRule(draft.id);
      setDrafts((prev) => (prev ? { ...prev, [type]: draftFrom(undefined) } : prev));
      flash('Alert rule removed.');
    } catch (e) {
      report(e);
    }
  };

  const saveDigest = async (next: DigestSettings) => {
    setDigest(next);
    try {
      const saved = await notificationsApi.updateDigest({
        frequency: next.frequency,
        channels: next.channels,
      });
      setDigest(saved);
      flash('Digest settings saved.');
    } catch (e) {
      report(e);
    }
  };

  const createEndpoint = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hookUrl.trim() || hookEvents.length === 0) return;
    setHookBusy(true);
    try {
      const created = await webhooksApi.create(hookUrl.trim(), hookEvents);
      setNewSecret(created.secret);
      setEndpoints((prev) => [
        {
          id: created.id,
          url: created.url,
          events: created.events,
          enabled: true,
          created_at: new Date().toISOString(),
        },
        ...(prev ?? []),
      ]);
      setHookUrl('');
      setHookEvents(['audit.completed']);
    } catch (err) {
      report(err);
    } finally {
      setHookBusy(false);
    }
  };

  const deleteEndpoint = async (ep: WebhookEndpoint) => {
    if (!confirm(`Delete webhook endpoint ${ep.url}? Future events will not be delivered there.`)) return;
    try {
      await webhooksApi.remove(ep.id);
      setEndpoints((prev) => (prev ? prev.filter((x) => x.id !== ep.id) : prev));
    } catch (e) {
      report(e);
    }
  };

  const testEndpoint = async (ep: WebhookEndpoint) => {
    try {
      await webhooksApi.test(ep.id);
      flash('Test delivery queued — see deliveries below.');
      setTimeout(loadDeliveries, 800);
    } catch (e) {
      report(e);
    }
  };

  const replay = async (d: WebhookDelivery) => {
    try {
      await webhooksApi.replay(d.id);
      flash('Delivery replay queued.');
      setTimeout(loadDeliveries, 800);
    } catch (e) {
      report(e);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="bx-micro mb-1">~/ notifications</p>
        <h1 className="bx-h1">Notifications</h1>
      </div>
      {savedFlash && <p className="bx-alert-ok" role="status">{savedFlash}</p>}

      {/* Alert rules */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ alert rules</p>
        <h2 className="text-base font-bold text-white">Alert rules</h2>
        <p className="bx-body mt-1">
          Email and Telegram destinations are configured in{' '}
          <a className="bx-link" href="/dashboard/settings">Settings</a>. Changes save
          immediately.
        </p>
        {drafts === null ? (
          <p className="mt-3 font-mono text-sm text-white/55">$ loading rules…</p>
        ) : (
          <div className="mt-3 space-y-2">
            {RULE_TYPES.map((type) => {
              const draft = drafts[type];
              const meta = RULE_META[type];
              const slackUrl = (draft.config?.slack_webhook_url as string | undefined) ?? '';
              return (
                <div key={type} className="bx-panel">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-white">{meta.label}</p>
                      <p className="text-xs text-white/55">{meta.hint}</p>
                      {draft.id === null && (
                        <p className="font-mono text-[11px] text-white/50">not configured yet</p>
                      )}
                    </div>
                    <button
                      role="switch"
                      aria-checked={draft.enabled}
                      aria-label={`Toggle rule: ${meta.label}`}
                      onClick={() => patchDraft(type, { enabled: !draft.enabled })}
                      className={`relative h-6 w-11 shrink-0 rounded-full transition ${draft.enabled ? 'bg-teal-400' : 'bg-white/15'}`}
                    >
                      <span
                        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${draft.enabled ? 'left-[22px]' : 'left-0.5'}`}
                      />
                    </button>
                  </div>

                  {type === 'rank_drop' && (
                    <div className="mt-2 flex items-center gap-2">
                      <label htmlFor="drop-positions" className="text-xs text-white/50">
                        Drop threshold (positions)
                      </label>
                      <input
                        id="drop-positions"
                        type="number"
                        min={1}
                        max={100}
                        defaultValue={Number(draft.config?.drop_positions ?? 5)}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (v >= 1 && v !== Number(draft.config?.drop_positions ?? 5)) {
                            patchDraft(type, {
                              config: { ...draft.config, drop_positions: v },
                            });
                          }
                        }}
                        className="bx-input !w-20 !px-2 !py-1 !text-xs"
                      />
                    </div>
                  )}

                  <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={`Channels for ${meta.label}`}>
                    {CHANNELS.map((ch) => (
                      <button
                        key={ch}
                        onClick={() => toggleChannel(type, ch)}
                        aria-pressed={draft.channels.includes(ch)}
                        disabled={!draft.enabled && !draft.channels.includes(ch)}
                        className={`rounded-full border px-2.5 py-1 text-xs font-medium transition disabled:opacity-40 ${
                          draft.channels.includes(ch)
                            ? 'border-teal-400/40 bg-teal-400/10 text-teal-300'
                            : 'border-white/10 bg-white/5 text-white/50'
                        }`}
                      >
                        {ch === 'inapp' ? 'in-app' : ch}
                      </button>
                    ))}
                    {draft.id && (
                      <button onClick={() => deleteRule(type)} className="bx-btn-xs-danger ml-auto">
                        Remove rule
                      </button>
                    )}
                  </div>

                  {draft.channels.includes('slack') && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input
                        type="url"
                        value={slackDrafts[type] ?? slackUrl}
                        onChange={(e) =>
                          setSlackDrafts((prev) => ({ ...prev, [type]: e.target.value }))
                        }
                        placeholder="https://hooks.slack.com/…"
                        className="bx-input min-w-[240px] flex-1 font-mono !text-xs"
                        aria-label={`Slack webhook URL for ${meta.label}`}
                      />
                      <button onClick={() => saveSlackUrl(type)} className="bx-btn-xs-secondary">
                        Save Slack URL
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {digest && (
          <div className="mt-6 border-t border-white/10 pt-4">
            <p className="text-sm font-semibold text-white">Digest email</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button
                role="switch"
                aria-checked={digest.frequency !== 'off'}
                aria-label="Toggle digest emails"
                onClick={() =>
                  saveDigest({
                    ...digest,
                    frequency: digest.frequency === 'off' ? 'weekly' : 'off',
                  })
                }
                className={`relative h-6 w-11 rounded-full transition ${digest.frequency !== 'off' ? 'bg-teal-400' : 'bg-white/15'}`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${digest.frequency !== 'off' ? 'left-[22px]' : 'left-0.5'}`}
                />
              </button>
              <select
                value={digest.frequency === 'off' ? 'weekly' : digest.frequency}
                disabled={digest.frequency === 'off'}
                onChange={(e) =>
                  saveDigest({ ...digest, frequency: e.target.value as 'daily' | 'weekly' })
                }
                className="bx-input !w-auto disabled:opacity-40"
                aria-label="Digest frequency"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
              <span className="text-xs text-white/55">
                summary email
                {digest.last_sent_at &&
                  ` · last sent ${new Date(digest.last_sent_at).toLocaleDateString()}`}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Webhook endpoints */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ webhooks</p>
        <h2 className="text-base font-bold text-white">Webhook endpoints</h2>
        <p className="bx-body mt-1">
          Receive signed event deliveries (<span className="font-mono text-xs">X-BSEO-Signature</span>)
          at your own URL. The signing secret is shown once at creation.
        </p>

        {newSecret && (
          <div className="bx-alert-warn mt-3" role="alert">
            <p className="font-semibold">Webhook signing secret — copy it now, it won&rsquo;t be shown again.</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="bx-input font-mono !text-xs">{newSecret}</code>
              <button
                onClick={() => navigator.clipboard.writeText(newSecret).catch(() => {})}
                className="bx-btn-xs-secondary"
              >
                Copy
              </button>
              <button onClick={() => setNewSecret(null)} className="text-xs text-white/50 hover:underline">
                I&rsquo;ve saved it
              </button>
            </div>
          </div>
        )}

        {endpoints === null ? (
          <p className="mt-3 font-mono text-sm text-white/55">$ loading endpoints…</p>
        ) : endpoints.length === 0 ? (
          <p className="mt-3 text-sm text-white/55">No webhook endpoints yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {endpoints.map((ep) => (
              <li key={ep.id} className="bx-panel flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-mono text-sm text-white/85">{ep.url}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-white/55">
                    {ep.events.join(', ')} · {ep.enabled ? 'enabled' : 'disabled'}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <button onClick={() => testEndpoint(ep)} className="bx-btn-xs-secondary">
                    Send test
                  </button>
                  <button onClick={() => deleteEndpoint(ep)} className="bx-btn-xs-danger">
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={createEndpoint} className="mt-4 space-y-3 border-t border-white/10 pt-4">
          <div>
            <label htmlFor="hook-url" className="bx-label">Endpoint URL</label>
            <input
              id="hook-url"
              type="url"
              value={hookUrl}
              onChange={(e) => setHookUrl(e.target.value)}
              placeholder="https://your-app.com/hooks/seo"
              className="bx-input font-mono"
            />
          </div>
          <div>
            <p className="bx-label">Events</p>
            <div className="flex flex-wrap gap-1.5">
              {catalog.map((ev) => (
                <button
                  type="button"
                  key={ev}
                  onClick={() =>
                    setHookEvents((prev) =>
                      prev.includes(ev) ? prev.filter((x) => x !== ev) : [...prev, ev],
                    )
                  }
                  aria-pressed={hookEvents.includes(ev)}
                  className={`rounded-full border px-2.5 py-1 font-mono text-xs transition ${
                    hookEvents.includes(ev)
                      ? 'border-teal-400/40 bg-teal-400/10 text-teal-300'
                      : 'border-white/10 bg-white/5 text-white/50'
                  }`}
                >
                  {ev}
                </button>
              ))}
            </div>
          </div>
          <button
            type="submit"
            disabled={hookBusy || !hookUrl.trim() || hookEvents.length === 0}
            className="bx-btn-primary"
          >
            {hookBusy ? 'Creating…' : 'Add endpoint'}
          </button>
        </form>

        {/* Deliveries */}
        <div className="mt-6 border-t border-white/10 pt-4">
          <p className="text-sm font-semibold text-white">Recent deliveries</p>
          {deliveries === null ? (
            <p className="mt-2 font-mono text-sm text-white/55">$ loading deliveries…</p>
          ) : deliveries.length === 0 ? (
            <p className="mt-2 text-sm text-white/55">No deliveries yet.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {deliveries.map((d) => (
                <li key={d.id} className="bx-panel flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="flex items-center gap-2 font-mono text-sm text-white/85">
                      <span className={`bx-pill ${DELIVERY_PILL[d.status] ?? 'bx-pill-info'}`}>
                        <span className="bx-dot" />
                        {d.status}
                      </span>
                      {d.event}
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-white/55">
                      {d.endpoint_url} · attempts {d.attempts}
                      {d.last_status_code ? ` · HTTP ${d.last_status_code}` : ''}
                      {d.last_error ? ` · ${d.last_error}` : ''} ·{' '}
                      {new Date(d.created_at).toLocaleString()}
                    </p>
                  </div>
                  {d.status !== 'delivered' && (
                    <button onClick={() => replay(d)} className="bx-btn-xs-secondary">
                      Replay
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Delivery log (in-app center) */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ inbox</p>
        <h2 className="text-base font-bold text-white">Notification log</h2>
        <p className="bx-body mt-1">Everything the system tried to send you, per channel.</p>
        {log === null ? (
          <p className="mt-3 font-mono text-sm text-white/55">$ loading log…</p>
        ) : log.length === 0 ? (
          <p className="mt-3 text-sm text-white/55">No notifications sent yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {log.map((n) => (
              <li key={n.id} className="bx-panel flex items-start justify-between gap-3">
                <div>
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-white">
                    <span className={`bx-pill ${LOG_PILL[n.status] ?? 'bx-pill-info'}`}>
                      <span className="bx-dot" />
                      {n.status}
                    </span>
                    {n.notification_type.replace(/_/g, ' ')}
                    <span className="font-mono text-[11px] text-white/55">via {n.channel}</span>
                  </p>
                  {n.detail && <p className="mt-1 text-xs text-white/55">{n.detail}</p>}
                </div>
                <span className="shrink-0 font-mono text-[11px] text-white/50">
                  {new Date(n.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
