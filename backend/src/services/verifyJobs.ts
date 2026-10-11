// S-08: weekly domain re-verification job processor.
//
// Re-checks that an already-verified site still proves ownership. If the
// token is gone (or the domain no longer exists), the site is unverified —
// paid/crawl features gate on `verified`, so a lapsed domain can't keep
// consuming them. Transient check failures keep the current state; the next
// weekly run retries.
import type { Job } from 'bullmq';
import { query } from '../db.js';
import { decideReverify } from './domainVerification.js';

export async function reverifyProcessor(job: Job): Promise<void> {
  const { siteId, tenantId } = job.data as { siteId: string; tenantId: string };
  const r = await query(
    `SELECT id, domain, verify_token FROM sites
     WHERE id = $1 AND tenant_id = $2 AND verified = true`,
    [siteId, tenantId],
  );
  const site = r.rows[0] as { id: string; domain: string; verify_token: string | null } | undefined;
  if (!site) return; // deleted or already unverified — nothing to do
  if (!site.verify_token) {
    // Verified without a token (legacy) — stamp the check and move on.
    await query(`UPDATE sites SET last_reverified_at = now() WHERE id = $1`, [site.id]);
    return;
  }
  const decision = await decideReverify(site.domain, site.verify_token);
  if (decision === 'unverified') {
    await query(
      `UPDATE sites SET verified = false, verified_at = NULL, last_reverified_at = now()
       WHERE id = $1`,
      [site.id],
    );
    console.log(`[reverify] unverified ${site.domain} (ownership proof lost)`);
  } else {
    await query(`UPDATE sites SET last_reverified_at = now() WHERE id = $1`, [site.id]);
    if (decision === 'transient') {
      console.log(`[reverify] transient check failure for ${site.domain} — keeping verified, will retry`);
    }
  }
}
