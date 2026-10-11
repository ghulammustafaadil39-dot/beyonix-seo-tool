import { emitWebhookEvent } from './webhookDelivery.js';

// W-06: minimal internal plugin contract. Plugins register hooks around
// audit completion / report generation; a failing plugin NEVER breaks the
// job that triggered the hook (errors are caught + logged per plugin).

export interface PluginContext {
  tenantId: string;
  siteId?: string;
  resourceId?: string;
  payload: Record<string, unknown>;
}
export interface BeyonixPlugin {
  name: string;
  onAuditComplete?: (ctx: PluginContext) => Promise<void> | void;
  onReportGenerated?: (ctx: PluginContext) => Promise<void> | void;
}

const registry: BeyonixPlugin[] = [];
export function registerPlugin(p: BeyonixPlugin): void {
  if (!registry.some((x) => x.name === p.name)) registry.push(p);
}
export function listPlugins(): string[] { return registry.map((p) => p.name); }
export function clearPluginsForTests(): void { registry.length = 0; }

export async function runPluginHooks(event: 'audit.completed' | 'report.ready', ctx: PluginContext): Promise<{ ran: string[]; failed: string[] }> {
  const ran: string[] = []; const failed: string[] = [];
  for (const p of registry) {
    const hook = event === 'audit.completed' ? p.onAuditComplete : p.onReportGenerated;
    if (!hook) continue;
    try { await hook(ctx); ran.push(p.name); }
    catch (e) { failed.push(p.name); console.error(`[plugin] ${p.name} failed on ${event}:`, (e as Error).message); }
  }
  return { ran, failed };
}

/**
 * Reference plugin: Slack-notify-on-audit-complete, delivered through the
 * EXISTING signed webhook system (F-10) — a tenant endpoint subscribed to
 * `audit.completed` (e.g. a Slack incoming-webhook bridge URL) receives the
 * signed delivery with retries + replay. No parallel notify path is built.
 */
export const slackAuditNotifyPlugin: BeyonixPlugin = {
  name: 'slack-notify-on-audit-complete',
  async onAuditComplete(ctx: PluginContext) {
    await emitWebhookEvent(ctx.tenantId, 'audit.completed', {
      siteId: ctx.siteId, auditId: ctx.resourceId,
      title: 'Audit completed',
      body: `Audit ${ctx.resourceId ?? ''} finished for site ${ctx.siteId ?? ''}. Score: ${String(ctx.payload.score ?? 'n/a')}.`,
      via: 'plugin:slack-notify-on-audit-complete',
    });
  },
};

export function registerDefaultPlugins(): void { registerPlugin(slackAuditNotifyPlugin); }
