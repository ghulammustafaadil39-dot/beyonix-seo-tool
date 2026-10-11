/**
 * lib/mock/notifications.ts — F-10 Notifications UI (mock-data adapter).
 * Pending backend endpoints (Backend Lead):
 *   GET/PATCH /api/v1/notifications/rules      → per-user alert rules
 *   GET /api/v1/notifications                  → in-app notification center
 *   POST /api/v1/notifications/:id/read
 * The settings notify_email/telegram fields are real and stay primary.
 * Rendered with <MockBanner/>.
 */

export type Channel = 'email' | 'telegram' | 'slack' | 'webhook';

export interface AlertRule {
  id: string;
  event: 'rank_drop' | 'critical_issue' | 'site_down' | 'limit_near' | 'report_ready';
  label: string;
  threshold: string;
  channels: Channel[];
  enabled: boolean;
}

export interface AppNotification {
  id: string;
  title: string;
  detail: string;
  severity: 'info' | 'warning' | 'critical';
  read: boolean;
  at: string;
}

export interface DigestSettings {
  enabled: boolean;
  frequency: 'daily' | 'weekly';
  channel: 'email';
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockRules(): Promise<AlertRule[]> {
  await delay(250);
  return [
    { id: 'r1', event: 'rank_drop', label: 'Keyword drops more than 5 positions', threshold: '5 positions', channels: ['email'], enabled: true },
    { id: 'r2', event: 'critical_issue', label: 'New critical audit issue', threshold: 'any', channels: ['email', 'telegram'], enabled: true },
    { id: 'r3', event: 'site_down', label: 'Site unreachable during crawl', threshold: 'any', channels: ['email', 'slack'], enabled: true },
    { id: 'r4', event: 'limit_near', label: 'Plan limit reaches 80%', threshold: '80%', channels: ['email'], enabled: true },
    { id: 'r5', event: 'report_ready', label: 'Weekly report is ready', threshold: 'weekly', channels: ['email'], enabled: false },
  ];
}

export async function mockNotifications(): Promise<AppNotification[]> {
  await delay(250);
  return [
    { id: 'n1', title: 'Rank drop detected', detail: '“invoicing software” fell 7 positions (4 → 11)', severity: 'warning', read: false, at: '2026-10-10T08:00:00Z' },
    { id: 'n2', title: 'Audit finished', detail: 'example.com — score 87/100, 3 new issues', severity: 'info', read: false, at: '2026-10-09T14:30:00Z' },
    { id: 'n3', title: 'AI citation won', detail: 'ChatGPT cited your pricing page for “best invoicing software”', severity: 'info', read: true, at: '2026-10-08T11:15:00Z' },
  ];
}

export async function mockDigest(): Promise<DigestSettings> {
  await delay(200);
  return { enabled: true, frequency: 'weekly', channel: 'email' };
}
