// BullMQ processors for the crawl queue: full site crawl ('crawl-site')
// and homepage light check ('light-check'). Idempotent handlers — a second
// run for the same site never creates a duplicate audit within 24h.
//
// C-04/F-02 additions:
// - audit_pages rows per crawled page (per-page detail, link graph, simhash,
//   ETag/Last-Modified for incremental recrawl)
// - inlink counts, orphan pages (sitemap URLs with no inlinks), near-duplicate
//   clusters (simhash) fed into the rules as context
// - impact score per issue (severity x page importance)
// - audit_diffs: new/resolved issues vs the previous done audit
// - regression alerts: new error issues -> alert_events (F-10 hook) + notify
// - crawl resume: crawl_state persisted every 10 pages; a retried job resumes
// - incremental recrawl: 304 responses reuse the previous page record and its
//   issues are carried over as still-open

import type { Job } from 'bullmq';
import { query, type QueryFn } from '../db.js';
import { getPlan } from '../plans.js';
import { recordUsage } from '../metering.js';
import { getNotify } from '../providers/notify.js';
import { crawlSite, type AnalyzedPage, type CrawlState } from './crawler.js';
import { runRules, scoreFor, type IssueDraft, type RuleCtx } from './auditRules.js';
import { checkLimit } from '../metering.js';
import { isPlanId, type PlanId } from '../plans.js';
import { getPageSpeedMetrics } from './pagespeed.js';
import { requireSite, siteUrl } from './sites.js';
import { findOrphanPages } from './sitemap.js';
import { clusterNearDuplicates } from './simhash.js';
import { impactScore, diffIssues } from './auditDiff.js';
import { Jobs } from '../queues.js';
import { runPluginHooks } from './plugins.js';

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

interface PageValidators {
  etag: string | null;
  lastModified: string | null;
}

/** Previous audit's page validators for incremental recrawl. Pure. */
export function buildConditionalMap(
  rows: Array<{ url: string; etag: string | null; last_modified: string | null }>,
): Map<string, { etag?: string; lastModified?: string }> {
  const m = new Map<string, { etag?: string; lastModified?: string }>();
  for (const r of rows) {
    if (r.etag || r.last_modified) {
      m.set(r.url, {
        ...(r.etag ? { etag: r.etag } : {}),
        ...(r.last_modified ? { lastModified: r.last_modified } : {}),
      });
    }
  }
  return m;
}

function normalizeUrlKey(u: string): string {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.href;
  } catch {
    return u;
  }
}

function buildCtx(
  pages: AnalyzedPage[],
  robotsFound: boolean,
  sitemapFound: boolean,
  sitemapUrls: string[],
  redirectChains: Array<{ from: string; to: string; hops: number | null; loopSuspected: boolean }>,
  pagespeed?: { lcpMs: number | null; cls: number | null; performanceScore: number | null } | null,
): RuleCtx {
  const titleCounts = new Map<string, number>();
  const metaDescCounts = new Map<string, number>();
  const inlinks = new Map<string, number>();
  const linkedTargets = new Set<string>();
  for (const p of pages) {
    const t = p.title.trim().toLowerCase();
    if (t) titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);
    const d = (p.metaDescription ?? '').trim().toLowerCase();
    if (d) metaDescCounts.set(d, (metaDescCounts.get(d) ?? 0) + 1);
    for (const l of p.links) {
      if (!l.internal) continue;
      const key = normalizeUrlKey(l.absolute);
      linkedTargets.add(key);
      inlinks.set(key, (inlinks.get(key) ?? 0) + 1);
    }
  }
  const crawled = new Set(pages.map((p) => normalizeUrlKey(p.url)));
  const orphans = findOrphanPages(sitemapUrls, crawled, linkedTargets);
  const dupClusters = clusterNearDuplicates(
    pages.filter((p) => p.statusCode === 200 && p.simhash).map((p) => ({ url: p.url, simhash: p.simhash! })),
  );
  const homepageUrl = pages[0]?.url;
  return {
    titleCounts, metaDescCounts, robotsFound, sitemapFound,
    pagespeed: pagespeed ?? null, orphans, dupClusters, inlinks, homepageUrl, redirectChains,
  };
}

async function insertIssues(
  q: QueryFn,
  tenantId: string,
  auditId: string,
  siteId: string,
  issues: IssueDraft[],
  inlinks: Map<string, number>,
  homepageUrl: string | undefined,
): Promise<void> {
  if (issues.length === 0) return;
  const rows: string[] = [];
  const params: unknown[] = [];
  issues.forEach((iss, i) => {
    const o = i * 9;
    rows.push(
      `(gen_random_uuid(), $${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9}, 'open')`,
    );
    const impact = impactScore(
      iss.severity as 'info' | 'warning' | 'error',
      inlinks.get(normalizeUrlKey(iss.url)) ?? 0,
      homepageUrl !== undefined && normalizeUrlKey(iss.url) === normalizeUrlKey(homepageUrl),
    );
    params.push(tenantId, auditId, siteId, iss.type, iss.severity, iss.url, iss.detail, iss.fix_suggestion, impact);
  });
  await q(
    `INSERT INTO audit_issues (id, tenant_id, audit_id, site_id, type, severity, url, detail, fix_suggestion, impact, status)
     VALUES ${rows.join(',')}`,
    params,
  );
}

async function insertPages(
  q: QueryFn,
  tenantId: string,
  auditId: string,
  siteId: string,
  pages: AnalyzedPage[],
  inlinks: Map<string, number>,
): Promise<void> {
  if (pages.length === 0) return;
  const rows: string[] = [];
  const params: unknown[] = [];
  pages.forEach((p, i) => {
    const o = i * 18;
    rows.push(
      `(gen_random_uuid(), $${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9}, $${o + 10}, $${o + 11}, $${o + 12}, $${o + 13}, $${o + 14}, $${o + 15}, $${o + 16}, $${o + 17}, $${o + 18})`,
    );
    params.push(
      tenantId, auditId, siteId, p.url, p.statusCode,
      p.title || null, p.wordCount, p.loadMs,
      p.etag ?? null, p.lastModified ?? null, p.canonical ?? null,
      JSON.stringify(p.hreflangs ?? []),
      inlinks.get(normalizeUrlKey(p.url)) ?? 0,
      JSON.stringify((p.links ?? []).filter((l) => l.internal).map((l) => l.absolute).slice(0, 500)),
      p.simhash ?? null,
      p.redirectHops ?? 0,
      JSON.stringify((p.images ?? []).slice(0, 100).map((im) => ({ src: im.src, alt: im.alt, bytes: im.bytes ?? null }))),
      p.notModified ?? false,
    );
  });
  await q(
    `INSERT INTO audit_pages (id, tenant_id, audit_id, site_id, url, status_code, title, word_count, load_ms,
       etag, last_modified, canonical, hreflangs, inlinks, outlinks, simhash, redirect_hops, images, reused_conditional)
     VALUES ${rows.join(',')}
     ON CONFLICT (audit_id, url) DO NOTHING`,
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

/** F-10 hook: record an alert event for the notification-rules engine. */
export async function emitAlert(
  q: QueryFn,
  tenantId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await q(
      `INSERT INTO alert_events (id, tenant_id, type, payload)
       VALUES (gen_random_uuid(), $1, $2, $3)`,
      [tenantId, type, JSON.stringify(payload)],
    );
  } catch (err) {
    console.error('[alerts] emit failed:', err instanceof Error ? err.message : err);
  }
}

/** Persist crawl resume state (best effort — never fails the crawl). */
async function persistCrawlState(q: QueryFn, tenantId: string, auditId: string, state: CrawlState): Promise<void> {
  try {
    await q(`UPDATE audits SET crawl_state = $3 WHERE id = $1 AND tenant_id = $2`, [
      auditId,
      tenantId,
      JSON.stringify({ visited: state.visited.slice(-2000), queue: state.queue.slice(0, 2000), done: state.done }),
    ]);
  } catch {
    /* best effort */
  }
}

/** Previous DONE audit for this site (for diffs + incremental validators). */
async function prevDoneAudit(
  q: QueryFn,
  tenantId: string,
  siteId: string,
  excludeAuditId: string,
): Promise<{ id: string } | null> {
  const r = await q(
    `SELECT id FROM audits
     WHERE site_id = $1 AND tenant_id = $2 AND status = 'done' AND id <> $3
     ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
    [siteId, tenantId, excludeAuditId],
  );
  return (r.rows[0] as { id: string } | undefined) ?? null;
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

    // Crawl resume: a retried job picks up where the previous attempt stopped.
    let resumeState: CrawlState | undefined;
    const stRow = await q(`SELECT crawl_state FROM audits WHERE id = $1 AND tenant_id = $2`, [auditId, tenantId]);
    const saved = stRow.rows[0]?.crawl_state as CrawlState | null;
    if (saved && Array.isArray(saved.visited) && saved.done > 0) {
      resumeState = saved;
    }

    // Incremental recrawl: validators from the previous done audit.
    const prev = await prevDoneAudit(q, tenantId, siteId, auditId);
    let conditional: Map<string, { etag?: string; lastModified?: string }> | undefined;
    let prevPages: Array<{ url: string; etag: string | null; last_modified: string | null }> = [];
    if (prev) {
      const pr = await q(
        `SELECT url, etag, last_modified FROM audit_pages WHERE audit_id = $1 AND tenant_id = $2`,
        [prev.id, tenantId],
      );
      prevPages = pr.rows as typeof prevPages;
      conditional = buildConditionalMap(prevPages);
    }

    const onState = (s: CrawlState): void => {
      void persistCrawlState(q, tenantId, auditId as string, s);
    };

    const { pages, brokenLinks, robotsFound, sitemapFound, sitemapUrls, redirectChains } = await crawlSite(
      siteUrl(site.domain),
      { maxPages: plan.crawl_pages, resumeState, onState, conditional },
    );

    // 304 pages: reuse the previous page record (carried into the new audit).
    const reusedUrls = new Set<string>();
    if (prev) {
      const prevByUrl = new Map(prevPages.map((p) => [p.url, p]));
      for (const p of pages) {
        if (p.notModified && prevByUrl.has(p.url)) reusedUrls.add(p.url);
      }
      if (reusedUrls.size > 0) {
        await q(
          `INSERT INTO audit_pages (id, tenant_id, audit_id, site_id, url, status_code, title, word_count, load_ms,
             etag, last_modified, canonical, hreflangs, inlinks, outlinks, simhash, redirect_hops, images, reused_conditional)
           SELECT gen_random_uuid(), $2, $3, $4, url, status_code, title, word_count, load_ms,
             etag, last_modified, canonical, hreflangs, inlinks, outlinks, simhash, redirect_hops, images, TRUE
           FROM audit_pages WHERE audit_id = $1 AND tenant_id = $2 AND url = ANY($5)`,
          [prev.id, tenantId, auditId, siteId, [...reusedUrls]],
        );
      }
    }
    const freshPages = pages.filter((p) => !reusedUrls.has(p.url));

    // Real Core Web Vitals for the homepage (PageSpeed, cached + quota'd).
    // Best-effort: a null result simply means no PageSpeed issues are reported.
    const ps = await getPageSpeedMetrics(siteUrl(site.domain), undefined, q).catch(() => ({
      metrics: null,
      cached: false,
      quotaExhausted: false,
    }));
    const pagespeed = ps.metrics;

    const ctx = buildCtx(pages, robotsFound, sitemapFound, sitemapUrls, redirectChains, pagespeed);
    const issues = runRules(pages, brokenLinks, ctx);
    const inlinks = ctx.inlinks ?? new Map<string, number>();

    // Carry over still-open issues for 304-reused pages (they were not re-checked).
    let carried = 0;
    if (prev && reusedUrls.size > 0) {
      const cr = await q(
        `INSERT INTO audit_issues (id, tenant_id, audit_id, site_id, type, severity, url, detail, fix_suggestion, impact, status)
         SELECT gen_random_uuid(), $2, $3, $4, type, severity, url, detail, fix_suggestion, impact, status
         FROM audit_issues WHERE audit_id = $1 AND tenant_id = $2 AND status = 'open' AND url = ANY($5)
         RETURNING id`,
        [prev.id, tenantId, auditId, siteId, [...reusedUrls]],
      );
      carried = cr.rows.length;
    }

    await insertIssues(q, tenantId, auditId, siteId, issues, inlinks, ctx.homepageUrl);
    await insertPages(q, tenantId, auditId, siteId, freshPages, inlinks);
    const score = scoreFor(issues);
    await q(
      `UPDATE audits SET status = 'done', finished_at = now(), score = $3, issues_count = $4, pages_crawled = $5, crawl_state = NULL
       WHERE id = $1 AND tenant_id = $2`,
      [auditId, tenantId, score, issues.length + carried, pages.length],
    );
    await recordUsage(tenantId, 'crawl_page', freshPages.length, siteId, undefined, q);

    // F-02: diff vs previous audit + regression alert on new errors.
    let diff: { newIssues: number; resolvedIssues: number; newErrors: number } | null = null;
    if (prev) {
      const prevIssues = (
        await q(`SELECT type, url FROM audit_issues WHERE audit_id = $1 AND tenant_id = $2`, [prev.id, tenantId])
      ).rows as Array<{ type: string; url: string }>;
      const currIssues = (
        await q(`SELECT type, url, severity FROM audit_issues WHERE audit_id = $1 AND tenant_id = $2`, [auditId, tenantId])
      ).rows as Array<{ type: string; url: string; severity: string }>;
      const d = diffIssues(prevIssues, currIssues);
      const newErrors = currIssues.filter(
        (i) => i.severity === 'error' && d.newIssues.some((n) => n.type === i.type && n.url === i.url),
      ).length;
      await q(
        `INSERT INTO audit_diffs (id, tenant_id, audit_id, site_id, prev_audit_id, new_issues, resolved_issues, new_errors, by_type)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`,
        [tenantId, auditId, siteId, prev.id, d.newIssues.length, d.resolved.length, newErrors, JSON.stringify(d.byType)],
      );
      diff = { newIssues: d.newIssues.length, resolvedIssues: d.resolved.length, newErrors };
      if (newErrors > 0) {
        await emitAlert(q, tenantId, 'audit.regression', {
          siteId, auditId, domain: site.domain, newErrors,
          message: `${newErrors} new critical issue(s) appeared since the last audit of ${site.domain}`,
        });
      }
    }

    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length > 0) await notifyErrors(tenant, site.domain, errors);

    // W-06: plugin hooks (errors isolated — never break the crawl result).
    void runPluginHooks('audit.completed', { tenantId, siteId, resourceId: auditId, payload: { score } }).catch((e) =>
      console.error('[plugin] audit.completed hooks failed:', e.message),
    );

    return {
      auditId,
      score,
      pagesCrawled: pages.length,
      issuesCount: issues.length + carried,
      errors: errors.length,
      reusedConditional: reusedUrls.size,
      diff,
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

  const { pages, brokenLinks, robotsFound, sitemapFound, sitemapUrls, redirectChains } = await crawlSite(
    siteUrl(site.domain),
    { maxPages: 1 },
  );
  const ctx = buildCtx(pages, robotsFound, sitemapFound, sitemapUrls, redirectChains);
  const issues = runRules(pages, brokenLinks, ctx);
  const score = scoreFor(issues);

  const ins = await q(
    `INSERT INTO audits (id, tenant_id, site_id, status, started_at, finished_at, score, issues_count, pages_crawled)
     VALUES (gen_random_uuid(), $1, $2, 'done', now(), now(), $3, $4, $5) RETURNING id`,
    [tenantId, siteId, score, issues.length, pages.length],
  );
  const auditId = ins.rows[0].id as string;
  await insertIssues(q, tenantId, auditId, siteId, issues, ctx.inlinks ?? new Map(), ctx.homepageUrl);
  await insertPages(q, tenantId, auditId, siteId, pages, ctx.inlinks ?? new Map());
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
  if (errors.length > prevErrors) {
    await emitAlert(q, tenantId, 'audit.regression', {
      siteId, auditId, domain: site.domain,
      newErrors: errors.length - prevErrors,
      message: `Critical issues grew from ${prevErrors} to ${errors.length} on ${site.domain}`,
    });
    await notifyErrors(tenant, site.domain, errors);
  }

  // W-06: plugin hooks (errors isolated).
  void runPluginHooks('audit.completed', { tenantId, siteId, resourceId: auditId, payload: { score, lightCheck: true } }).catch((e) =>
    console.error('[plugin] audit.completed hooks failed:', e.message),
  );

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
