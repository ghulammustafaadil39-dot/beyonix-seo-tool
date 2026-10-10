import type { Job } from 'bullmq';
import { query } from '../db.js';
import { generateOutline, generateDraft, estimateWords } from './contentEngine.js';
import { checkLimit } from '../metering.js';
import { isPlanId, type PlanId } from '../plans.js';
import { getNotify } from '../providers/notify.js';

export interface ContentJobData {
  pieceId: string;
  tenantId: string;
  /** Optional overrides from the enqueueing route; processor has sane defaults. */
  tone?: string;
  targetWords?: number;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * BullMQ processor for GENERATE_CONTENT jobs (content queue).
 * Idempotent: skips pieces that are no longer in 'draft' status.
 * On success the piece moves to 'review' and the tenant is notified.
 * Throws on failure so BullMQ retries (attempts/backoff per queue defaults).
 */
export async function contentProcessor(job: Job): Promise<unknown> {
  const data = job.data as ContentJobData;
  const { pieceId, tenantId } = data;
  if (!pieceId || !tenantId) throw new Error('content job missing pieceId/tenantId');

  const pr = await query(`SELECT * FROM content_pieces WHERE id = $1 AND tenant_id = $2`, [pieceId, tenantId]);
  if (pr.rows.length === 0) throw new Error(`content piece not found: ${pieceId}`);
  const piece = pr.rows[0];

  // Idempotency: only generate for pieces still awaiting generation.
  if (piece.status !== 'draft') return { skipped: true, status: piece.status };

  const sr = await query(`SELECT * FROM sites WHERE id = $1 AND tenant_id = $2`, [piece.site_id, tenantId]);
  if (sr.rows.length === 0) throw new Error(`site not found for content piece: ${pieceId}`);
  const site = sr.rows[0];

  // Cost guard: never spend our LLM budget for a tenant over their plan limit.
  // (Routes do a pre-flight check too, but the worker is the point of spend —
  //  this is what actually protects us. Skip quietly; the piece stays in
  //  draft so the user can retry after upgrading.)
  const tr = await query(`SELECT plan_id FROM tenants WHERE id = $1`, [tenantId]);
  const planId: PlanId = isPlanId(tr.rows[0]?.plan_id) ? tr.rows[0].plan_id : 'starter';
  const tone = data.tone ?? 'friendly professional';
  const targetWords = data.targetWords ?? 1200;
  const spendEstimate = targetWords + 400; // draft + outline
  const lim = await checkLimit(tenantId, planId, 'ai_words');
  if (lim.used + spendEstimate > lim.limit) {
    return { skipped: true, reason: 'ai_words_limit', used: lim.used, limit: lim.limit };
  }

  let keyword = '';
  if (piece.keyword_id) {
    const kr = await query(`SELECT keyword FROM keywords WHERE id = $1 AND tenant_id = $2`, [
      piece.keyword_id,
      tenantId,
    ]);
    keyword = kr.rows[0]?.keyword ?? '';
  }

  const outline = await generateOutline(tenantId, {
    keyword,
    title: piece.title,
    tone,
    siteDomain: site.domain,
    siteId: site.id,
  });
  const draft = await generateDraft(tenantId, {
    keyword,
    title: piece.title,
    outline,
    tone,
    targetWords,
    siteId: site.id,
  });
  const totalWords = estimateWords(outline) + draft.words;

  await query(
    `UPDATE content_pieces
        SET outline = $1, draft = $2, status = 'review',
            ai_words_used = $3, updated_at = now()
      WHERE id = $4 AND tenant_id = $5`,
    [outline, draft.text, totalWords, pieceId, tenantId],
  );

  try {
    const tr = await query(`SELECT notify_email, telegram_chat_id FROM tenants WHERE id = $1`, [tenantId]);
    const t = tr.rows[0];
    const notify = getNotify();
    const msg = `New content draft ready for review: ${piece.title}`;
    if (t?.notify_email) {
      await notify.sendEmail(t.notify_email, 'Content draft ready', `<p>${escapeHtml(msg)}</p>`);
    }
    if (t?.telegram_chat_id) {
      await notify.sendTelegram(t.telegram_chat_id, msg);
    }
  } catch (err) {
    // Notification failure must not fail the job.
    console.warn('[content] notify failed:', (err as Error).message);
  }

  return { pieceId, words: totalWords };
}
