import type { Job } from 'bullmq';
import { getGoogle } from '../providers/google.js';
import { getNotify } from '../providers/notify.js';
import { decrypt } from '../crypto.js';
import { requireSite, siteUrl } from './sites.js';
import { rescoreToxicLinks } from './toxicLinks.js';
import { query as defaultQuery, type QueryFn } from '../db.js';

interface BacklinkJobData {
  siteId: string;
  tenantId: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function notifyBacklinkChanges(
  q: QueryFn,
  tenantId: string,
  domain: string,
  gained: Array<{ sourceUrl: string; targetUrl: string }>,
  lost: Array<{ sourceUrl: string; targetUrl: string }>,
): Promise<void> {
  if (gained.length === 0 && lost.length === 0) return;
  try {
    const t = (
      await q(`SELECT notify_email, telegram_chat_id FROM tenants WHERE id = $1`, [tenantId])
    ).rows[0] as { notify_email: string | null; telegram_chat_id: string | null } | undefined;
    if (!t || (!t.notify_email && !t.telegram_chat_id)) return;
    const notify = getNotify();
    const lines: string[] = [];
    if (gained.length > 0) {
      lines.push(`New backlinks (${gained.length}):`);
      for (const l of gained.slice(0, 10)) lines.push(`+ ${l.sourceUrl}`);
    }
    if (lost.length > 0) {
      lines.push(`Lost backlinks (${lost.length}):`);
      for (const l of lost.slice(0, 10)) lines.push(`- ${l.sourceUrl}`);
    }
    const text = `Backlink changes for ${domain}:\n${lines.join('\n')}`;
    if (t.notify_email) {
      await notify.sendEmail(
        t.notify_email,
        `Backlink changes — ${domain}`,
        `<h3>Backlink changes — ${esc(domain)}</h3><pre>${esc(lines.join('\n'))}</pre>`,
      );
    }
    if (t.telegram_chat_id) await notify.sendTelegram(t.telegram_chat_id, text);
  } catch (err) {
    console.warn('[backlinks] notify failed:', (err as Error).message);
  }
}

/**
 * Refreshes the site's backlink list and runs the lost-link sweep.
 *
 * Data sources (v1): the Google provider (mock data in dev; the real GSC API
 * exposes no links endpoint, so the real provider returns []) and CSV
 * uploads (POST /sites/:id/backlinks/upload).
 *
 * Lost detection: links not seen for 30+ days are marked lost and the
 * tenant is notified. When the real provider returns no data we still run
 * the sweep so CSV-uploaded links age out honestly instead of being wiped.
 */
export async function backlinkProcessor(job: Job): Promise<unknown> {
  const { siteId, tenantId } = job.data as BacklinkJobData;
  const q = defaultQuery;
  const site = await requireSite(tenantId, siteId, q);

  const token =
    site.gsc_connected && site.gsc_refresh_token_enc
      ? decrypt(site.gsc_refresh_token_enc)
      : 'mock';
  const provider = getGoogle();
  const links = await provider.backlinks(token, siteUrl(site.domain));

  const gained: Array<{ sourceUrl: string; targetUrl: string }> = [];
  if (links.length > 0 || provider.isMock) {
    // A1-L1: batch the upserts — one statement per 500 links. The
    // `xmax = 0` trick still identifies freshly-inserted rows per row.
    for (let i = 0; i < links.length; i += 500) {
      const batch = links.slice(i, i + 500);
      const values: string[] = [];
      const params: unknown[] = [];
      batch.forEach((link, j) => {
        const o = j * 4;
        values.push(`(gen_random_uuid(), $${o + 1}, $${o + 2}, $${o + 3}, $${o + 4})`);
        params.push(tenantId, siteId, link.sourceUrl, link.targetUrl);
      });
      const r = await q(
        `INSERT INTO backlinks (id, tenant_id, site_id, source_url, target_url)
         VALUES ${values.join(', ')}
         ON CONFLICT (site_id, source_url, target_url)
         DO UPDATE SET last_seen = CURRENT_DATE, status = 'active'
         RETURNING (xmax = 0) AS inserted, source_url, target_url`,
        params,
      );
      for (const row of r.rows) {
        if (row.inserted) gained.push({ sourceUrl: row.source_url as string, targetUrl: row.target_url as string });
      }
    }
  }

  // Lost sweep: anything unseen for 30+ days flips to lost (only newly-lost
  // rows are returned, so notifications fire once per link).
  const lostR = await q(
    `UPDATE backlinks SET status = 'lost'
     WHERE site_id = $1 AND tenant_id = $2 AND status = 'active'
       AND last_seen < CURRENT_DATE - interval '30 days'
     RETURNING source_url, target_url`,
    [siteId, tenantId],
  );
  const lost = lostR.rows.map((r: any) => ({ sourceUrl: r.source_url as string, targetUrl: r.target_url as string }));

  await notifyBacklinkChanges(q, tenantId, site.domain, gained, lost);

  // F-06: heuristic toxic scoring on every refresh.
  await rescoreToxicLinks(tenantId, siteId, site.domain, q);

  return { total: links.length, gained: gained.length, lost: lost.length };
}
