// BullMQ processors for the crawl queue: full site crawl ('crawl-site')
// and homepage light check ('light-check'). Idempotent handlers — a second
// run for the same site never creates a duplicate audit within 24h.

import type { Job } from 'bullmq';
import { query, type QueryFn } from '../db.js';
import { getPlan } from '../plans.js';
import { recordUsage } from '../metering.js';
import { getNotify } from '../providers/notify.js';
import { crawlSite, type AnalyzedPage } from './crawler.js';
import { runRules, scoreFor, type IssueDraft, type RuleCtx } from './auditRules.js';
import { checkLimit } from '../metering.js';
import { isPlanId, type PlanId } from '../plans.js';
import { getPageSpeedMetrics } from './pagespeed.js';
import { requireSite, siteUrl } from './sites.js';
import { Jobs } from '../queues.js';

export interface CrawlJobData {
  siteId: string;
  tenantId: string;
  /** audit row created by the route (or scheduler-less enqueue); processor creates one when absent */
  auditId?: string;
}

export interface ExistingAudit {
  status: string;
  started_at: Date | string | null;
}

/** Pure idempotency check: skip when another queued/running audit exists. */
export function shouldSkipCrawl(existing: ExistingAudit[]): boolean {
  return existing.some((a) => a.status === 'queued' || a.status === 'running');
}

function buildCtx(
  pages: AnalyzedPage[],
  robotsFound: boolean,
  sitemapFound: boolean,
  pagespeed?: { lcpMs: number | null; cls: number | null; performanceScore: number | null } | null,
): RuleCtx {
  const titleCounts = new Map<string, number>();
  const metaDescCounts = new Map<string, number>();
  for (const p of pages) {
    const t = p.title.trim().toLowerCase();
    if (t) titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);
    const d = (p.metaDescription ?? '').trim().toLowerCase();
    if (d) metaDescCounts.set(d, (metaDescCounts.get(d) ?? 0) + 1);
  }
  return { titleCounts, metaDescCounts, robotsFound, sitemapFound, pagespeed: pagespeed ?? null };
}

async function insertIssues(
  q: QueryFn,
  tenantId: string,
  auditId: string,
  siteId: string,
  issues: IssueDraft[],
): Promise<void> {
  if (issues.length === 0) return;
  const rows: string[] = [];
  const params: unknown[] = [];
  issues.forEach((iss, i) => {
    const o = i * 8;
    rows.push(
      `(gen_random_uuid(), $${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, 'open')`,
    );
    params.push(tenantId, auditId, siteId, iss.type, iss.severity, iss.url, iss.detail, iss.fix_suggestion);
  });
  await q(
    `INSERT INTO audit_issues (id, tenant_id, audit_id, site_id, type, severity, url, detail, fix_suggestion, status)
     VALUES ${rows.join(',')}`,
    params,
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface NotifyTarget {
  notify_email: string | null;
  telegram_chat_id: string | null;
}

/** Notify the tenant about critical (error) issues. Never throws — a failed
 *  notification must never fail the crawl job. */
async function notifyErrors(
  target: NotifyTarget,
  domain: string,
  errors: IssueDraft[],
): Promise<void> {
  try {
    const notify = getNotify();
    const n = errors.length;
    const top = errors
      .slice(0, 10)
      .map((e) => `• [${e.type}] ${e.url}\n  ${e.detail}`)
      .join('\n');
    if (target.notify_email) {
      const subject = `[Beyonix SEO] ${n} critical SEO issue${n === 1 ? '' : 's'} on ${domain}`;
      const html =
        `<p>Your site audit for <b>${escapeHtml(domain)}</b> found ` +
        `<b>${n}</b> critical issue${n === 1 ? '' : 's'}:</p>` +
        `<pre>${escapeHtml(top)}</pre>` +
        `<p>Log in to your Beyonix SEO dashboard to review the fixes.</p>`;
      await notify.sendEmail(target.notify_email, subject, html);
    }
    if (target.telegram_chat_id) {
      await notify.sendTelegram(
        target.telegram_chat_id,
        `🔍 SEO audit for ${domain}: ${n} critical issue${n === 1 ? '' : 's'} found.\n${top.slice(0, 1500)}`,
      );
    }
  } catch (err) {
    console.error('[crawlJobs] notify failed:', err instanceof Error ? err.message : err);
  }
}

async function loadTenant(q: QueryFn, tenantId: string): Promise<NotifyTarget & { plan_id: string }> {
  const r = await q(`SELECT id, plan_id, notify_email, telegram_chat_id FROM tenants WHERE id = $1`, [
    tenantId,
  ]);
  if (r.rows.length === 0) throw new Error(`Tenant ${tenantId} not found`);
  return r.rows[0] as NotifyTarget & { plan_id: string };
}

async function markFailed(q: QueryFn, tenantId: string, auditId: string, err: unknown): Promise<void> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
  try {
    await q(
      `UPDATE audits SET status = 'failed', finished_at = now(), error = $3
       WHERE id = $1 AND tenant_id = $2`,
      [auditId, tenantId, message],
    );
  } catch {
    /* best effort */
  }
}

/** Full audit: crawl up to plan.crawl_pages, run rules, store issues + score. */
async function runCrawlSite(data: CrawlJobData, q: QueryFn = query): Promise<unknown> {
  const { siteId, tenantId } = data;
  const site = await requireSite(tenantId, siteId, q);
  const tenant = await loadTenant(q, tenantId);

  // Idempotency: another queued/running audit for this site in the last 24h?
  const dup = await q(
    `SELECT id, status, started_at FROM audits
     WHERE site_id = $1 AND tenant_id = $2
       AND status IN ('queued','running')
       AND (started_at IS NULL OR started_at > now() - interval '24 hours')
       AND ($3::uuid IS NULL OR id <> $3)`,
    [siteId, tenantId, data.auditId ?? null],
  );
  if (shouldSkipCrawl(dup.rows as ExistingAudit[])) {
    return { skipped: true, auditId: (dup.rows[0] as { id: string }).id };
  }

  let auditId = data.auditId ?? null;
  if (auditId) {
    await q(`UPDATE audits SET status = 'running' WHERE id = $1 AND tenant_id = $2`, [auditId, tenantId]);
  } else {
    const ins = await q(
      `INSERT INTO audits (id, tenant_id, site_id, status, started_at)
       VALUES (gen_random_uuid(), $1, $2, 'running', now()) RETURNING id`,
      [tenantId, siteId],
    );
    auditId = ins.rows[0].id as string;
  }

  try {
    const plan = getPlan(tenant.plan_id);
    const planId: PlanId = isPlanId(tenant.plan_id) ? tenant.plan_id : 'starter';
    // Monthly crawl-page budget guard at the point of spend (route did a
    // pre-flight; this is what actually protects us from overshoot).
    const crawlLim = await checkLimit(tenantId, planId, 'crawl_pages', q);
    if (crawlLim.used + plan.crawl_pages > crawlLim.limit) {
      await q(`UPDATE audits SET status = 'failed', finished_at = now(), error = $3
               WHERE id = $1 AND tenant_id = $2`, [auditId, tenantId, 'Monthly crawl budget reached. Upgrade to continue.']);
      return { skipped: true, reason: 'crawl_pages_limit' };
    }
    const { pages, brokenLinks, robotsFound, sitemapFound } = await crawlSite(siteUrl(site.domain), {
      maxPages: plan.crawl_pages,
    });
    // Real Core Web Vitals for the homepage (PageSpeed, free tier).
    // Best-effort: a null result simply means no PageSpeed issues are reported.
    const pagespeed = await getPageSpeedMetrics(siteUrl(site.domain)).catch(() => null);
    const issues = runRules(pages, brokenLinks, buildCtx(pages, robotsFound, sitemapFound, pagespeed));
    await insertIssues(q, tenantId, auditId, siteId, issues);
    const score = scoreFor(issues);
    await q(
      `UPDATE audits SET status = 'done', finished_at = now(), score = $3, issues_count = $4, pages_crawled = $5
       WHERE id = $1 AND tenant_id = $2`,
      [auditId, tenantId, score, issues.length, pages.length],
    );
    await recordUsage(tenantId, 'crawl_page', pages.length, siteId, undefined, q);

    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length > 0) await notifyErrors(tenant, site.domain, errors);

    return {
      auditId,
      score,
      pagesCrawled: pages.length,
      issuesCount: issues.length,
      errors: errors.length,
    };
  } catch (err) {
    await markFailed(q, tenantId, auditId, err);
    throw err;
  }
}

/** Light check: crawl only the homepage, store a done audit, alert when the
 *  error count grew vs the previous done audit. */
async function runLightCheck(data: CrawlJobData, q: QueryFn = query): Promise<unknown> {
  const { siteId, tenantId } = data;
  const site = await requireSite(tenantId, siteId, q);
  const tenant = await loadTenant(q, tenantId);

  const { pages, brokenLinks, robotsFound, sitemapFound } = await crawlSite(siteUrl(site.domain), {
    maxPages: 1,
  });
  const issues = runRules(pages, brokenLinks, buildCtx(pages, robotsFound, sitemapFound));
  const score = scoreFor(issues);

  const ins = await q(
    `INSERT INTO audits (id, tenant_id, site_id, status, started_at, finished_at, score, issues_count, pages_crawled)
     VALUES (gen_random_uuid(), $1, $2, 'done', now(), now(), $3, $4, $5) RETURNING id`,
    [tenantId, siteId, score, issues.length, pages.length],
  );
  const auditId = ins.rows[0].id as string;
  await insertIssues(q, tenantId, auditId, siteId, issues);
  await recordUsage(tenantId, 'crawl_page', pages.length, siteId, undefined, q);

  const errors = issues.filter((i) => i.severity === 'error');
  const prev = await q(
    `SELECT COALESCE(SUM(CASE WHEN severity = 'error' THEN 1 ELSE 0 END), 0)::int AS errors
     FROM audit_issues
     WHERE tenant_id = $1 AND audit_id = (
       SELECT id FROM audits
       WHERE site_id = $2 AND tenant_id = $1 AND status = 'done' AND id <> $3
       ORDER BY finished_at DESC NULLS LAST, started_at DESC NULLS LAST
       LIMIT 1
     )`,
    [tenantId, siteId, auditId],
  );
  const prevErrors = Number(prev.rows[0]?.errors ?? 0);
  if (errors.length > prevErrors) await notifyErrors(tenant, site.domain, errors);

  return {
    auditId,
    score,
    pagesCrawled: pages.length,
    issuesCount: issues.length,
    errors: errors.length,
    prevErrors,
  };
}

/** Entry point for the BullMQ crawl queue (also used by worker.ts). */
export async function crawlProcessor(job: Job): Promise<unknown> {
  if (job.name === Jobs.CRAWL_SITE) return runCrawlSite(job.data as CrawlJobData);
  if (job.name === Jobs.LIGHT_CHECK) return runLightCheck(job.data as CrawlJobData);
  throw new Error(`crawlProcessor: unknown job name "${job.name}"`);
}
