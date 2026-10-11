import { query as defaultQuery, type QueryFn } from '../db.js';
import { getNotify } from '../providers/notify.js';
import { registerUsageAlertHook } from '../metering.js';
import { emitWebhookEvent, validateWebhookUrl } from './webhookDelivery.js';

// ---------------------------------------------------------------------------
// F-10: notifications — per-user alert rules, digests, multi-channel
// dispatch (email / Telegram / Slack / webhooks / in-app center).
// ---------------------------------------------------------------------------

export type NotifyChannel = 'email' | 'telegram' | 'slack' | 'webhook' | 'inapp';

export type AlertRuleType = 'rank_drop' | 'critical_issue' | 'site_down' | 'limit_near';

export interface NotificationMessage {
  title: string;
  body: string;
  link?: string;
}

interface DispatchTarget {
  userId: string | null;
  email: string | null;
  telegramChatId: string | null;
  slackWebhookUrl: string | null;
}

async function resolveTargets(
  tenantId: string,
  ruleType: string,
  q: QueryFn,
): Promise<Array<{ ruleId: string | null; channels: NotifyChannel[]; target: DispatchTarget }>> {
  // Users with an enabled rule for this type get their configured channels.
  const rules = await q(
    `SELECT r.id, r.user_id, r.channels, r.config,
            u.email AS user_email, t.notify_email AS tenant_email,
            t.telegram_chat_id AS tenant_telegram
     FROM notification_rules r
     JOIN users u ON u.id = r.user_id
     JOIN tenants t ON t.id = r.tenant_id
     WHERE r.tenant_id = $1 AND r.rule_type = $2 AND r.enabled = TRUE`,
    [tenantId, ruleType],
  );
  const out: Array<{ ruleId: string | null; channels: NotifyChannel[]; target: DispatchTarget }> = [];
  for (const r of rules.rows) {
    const cfg = (r.config ?? {}) as Record<string, unknown>;
    out.push({
      ruleId: r.id as string,
      channels: (r.channels ?? []) as NotifyChannel[],
      target: {
        userId: r.user_id as string,
        email: (r.user_email as string) ?? (r.tenant_email as string) ?? null,
        telegramChatId: (cfg.telegram_chat_id as string) ?? (r.tenant_telegram as string) ?? null,
        slackWebhookUrl: (cfg.slack_webhook_url as string) ?? null,
      },
    });
  }
  // Fallback: no rule configured -> the tenant's notification email (in-app
  // log only if even that is missing).
  if (out.length === 0) {
    const t = await q(`SELECT notify_email, telegram_chat_id FROM tenants WHERE id = $1`, [tenantId]);
    out.push({
      ruleId: null,
      channels: ['email', 'inapp'],
      target: {
        userId: null,
        email: (t.rows[0]?.notify_email as string) ?? null,
        telegramChatId: (t.rows[0]?.telegram_chat_id as string) ?? null,
        slackWebhookUrl: null,
      },
    });
  }
  return out;
}

async function sendSlack(webhookUrl: string, msg: NotificationMessage): Promise<void> {
  await validateWebhookUrl(webhookUrl); // SSRF-checked like other webhooks
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `*${msg.title}*\n${msg.body}${msg.link ? `\n<${msg.link}|Open>` : ''}` }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Slack webhook HTTP ${res.status}`);
}

async function logNotification(
  q: QueryFn,
  tenantId: string,
  entry: {
    userId?: string | null;
    ruleId?: string | null;
    type: string;
    channel: NotifyChannel;
    status: 'sent' | 'failed' | 'skipped';
    detail?: string;
  },
): Promise<void> {
  await q(
    `INSERT INTO notification_log (id, tenant_id, user_id, rule_id, notification_type, channel, status, detail)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, entry.userId ?? null, entry.ruleId ?? null, entry.type, entry.channel, entry.status, entry.detail ?? null],
  );
}

/**
 * Dispatches a notification to every target with a matching alert rule
 * (or the tenant fallback). Each channel send is best-effort and logged.
 */
export async function dispatchNotification(
  tenantId: string,
  type: string,
  msg: NotificationMessage,
  opts: { ruleType?: AlertRuleType; userId?: string; q?: QueryFn } = {},
): Promise<void> {
  const q = opts.q ?? defaultQuery;
  const notify = getNotify();
  const targets = await resolveTargets(tenantId, opts.ruleType ?? type, q);

  for (const { ruleId, channels, target } of targets) {
    for (const channel of channels) {
      try {
        if (channel === 'email') {
          if (!target.email) throw new Error('no email on file');
          await notify.sendEmail(
            target.email,
            `[Beyonix SEO] ${msg.title}`,
            `<p>${msg.body}</p>${msg.link ? `<p><a href="${msg.link}">Open in dashboard</a></p>` : ''}`,
          );
        } else if (channel === 'telegram') {
          if (!target.telegramChatId) throw new Error('no telegram chat configured');
          await notify.sendTelegram(target.telegramChatId, `${msg.title}\n${msg.body}`);
        } else if (channel === 'slack') {
          if (!target.slackWebhookUrl) throw new Error('no Slack webhook configured');
          await sendSlack(target.slackWebhookUrl, msg);
        } else if (channel === 'webhook') {
          await emitWebhookEvent(tenantId, `notify.${type}`, { title: msg.title, body: msg.body, link: msg.link }, q);
        } else {
          // 'inapp': the notification_log row IS the inbox entry.
        }
        await logNotification(q, tenantId, {
          userId: target.userId,
          ruleId,
          type,
          channel,
          status: 'sent',
        });
      } catch (err) {
        await logNotification(q, tenantId, {
          userId: target.userId,
          ruleId,
          type,
          channel,
          status: 'failed',
          detail: (err as Error)?.message?.slice(0, 500) ?? String(err),
        });
      }
    }
  }
}

/**
 * Wires the default C-02 usage-alert hook (80%/100%) to the notification
 * system. Called once at API/worker boot (idempotent — re-registering is
 * harmless because dispatch is per-period-claimed in metering).
 */
export function wireDefaultUsageAlerts(): void {
  registerUsageAlertHook(async (info) => {
    await dispatchNotification(
      info.tenantId,
      'limit_near',
      {
        title: `Usage ${info.level}% of ${info.kind} limit`,
        body: `You've used ${info.used}/${info.limit} of your ${info.kind} allowance this billing period. Upgrade to raise the limit.`,
        link: '/dashboard/billing',
      },
      { ruleType: 'limit_near' },
    );
    // Also fan out to tenant webhook subscribers (F-10 event catalog).
    await emitWebhookEvent(info.tenantId, 'limit.near', {
      kind: info.kind,
      used: info.used,
      limit: info.limit,
      level: info.level,
    });
  });
}

// ---------------------------------------------------------------------------
// Digests (F-10)
// ---------------------------------------------------------------------------

/**
 * Sends due digests (daily/weekly). For each user with digest frequency !=
 * off whose last_sent_at is older than the period, emails a summary of
 * recent notifications and updates last_sent_at.
 */
export async function processDigests(q: QueryFn = defaultQuery): Promise<number> {
  const due = await q(
    `SELECT d.tenant_id, d.user_id, d.frequency, d.last_sent_at, u.email
     FROM notification_digests d
     JOIN users u ON u.id = d.user_id
     WHERE d.frequency IN ('daily', 'weekly')
       AND (d.last_sent_at IS NULL OR d.last_sent_at < now() - CASE d.frequency WHEN 'daily' THEN interval '23 hours' ELSE interval '6 days 23 hours' END)`,
  );
  let sent = 0;
  for (const row of due.rows) {
    const tenantId = row.tenant_id as string;
    const userId = row.user_id as string;
    const since = (row.last_sent_at as string | null) ?? new Date(Date.now() - 8 * 86400_000).toISOString();
    const items = await q(
      `SELECT notification_type, channel, status, created_at FROM notification_log
       WHERE tenant_id = $1 AND (user_id = $2 OR user_id IS NULL) AND created_at >= $3
       ORDER BY created_at DESC LIMIT 50`,
      [tenantId, userId, since],
    );
    if (items.rows.length > 0) {
      const lines = items.rows
        .map((i: any) => `• [${i.notification_type}] ${i.channel} — ${i.status}`)
        .join('<br>');
      try {
        await getNotify().sendEmail(
          row.email as string,
          `[Beyonix SEO] Your ${row.frequency} digest`,
          `<p>Here's what happened since your last digest:</p><p>${lines}</p>`,
        );
      } catch (err) {
        console.error('[notifications] digest send failed', err);
      }
    }
    await q(`UPDATE notification_digests SET last_sent_at = now() WHERE tenant_id = $1 AND user_id = $2`, [
      tenantId,
      userId,
    ]);
    sent += 1;
  }
  return sent;
}
