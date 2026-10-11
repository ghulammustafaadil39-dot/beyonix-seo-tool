// S-01: email verification tokens (signup + email change).
// Only SHA-256 hashes are stored; the raw token is emailed once and never logged.
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db.js';
import { getNotify } from '../providers/notify.js';

export type VerifyPurpose = 'signup' | 'email_change';

const RESEND_WINDOW = `1 hour`;
const MAX_RESENDS_PER_WINDOW = 3;

export function hashVerificationToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Issues a new verification token for the user; returns the raw token (email it, never store it). */
export async function issueVerificationToken(
  userId: string,
  purpose: VerifyPurpose = 'signup',
): Promise<string> {
  const raw = randomBytes(32).toString('hex');
  await query(
    `INSERT INTO email_verification_tokens (id, user_id, token_hash, purpose, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, now() + interval '24 hours')`,
    [userId, hashVerificationToken(raw), purpose],
  );
  return raw;
}

/** Throws when the user requested too many verification emails recently. */
export async function assertResendAllowed(userId: string): Promise<void> {
  const r = await query(
    `SELECT count(*)::int AS c FROM email_verification_tokens
     WHERE user_id = $1 AND created_at > now() - interval '${RESEND_WINDOW}'`,
    [userId],
  );
  if ((r.rows[0]?.c ?? 0) >= MAX_RESENDS_PER_WINDOW) {
    const { ApiError } = await import('../errors.js');
    throw new ApiError(429, 'RATE_LIMITED', 'Too many verification emails — please try again later');
  }
}

/**
 * Consumes a raw token. Returns the user/purpose on success, null when the
 * token is unknown, expired, already used, or for a different purpose.
 */
export async function consumeVerificationToken(
  rawToken: string,
  purpose?: VerifyPurpose,
): Promise<{ userId: string; purpose: VerifyPurpose } | null> {
  const r = await query(
    `SELECT id, user_id, purpose, expires_at, consumed_at
     FROM email_verification_tokens WHERE token_hash = $1`,
    [hashVerificationToken((rawToken ?? '').trim())],
  );
  const row = r.rows[0];
  if (!row || row.consumed_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  if (purpose && row.purpose !== purpose) return null;
  const u = await query(
    `UPDATE email_verification_tokens SET consumed_at = now()
     WHERE id = $1 AND consumed_at IS NULL`,
    [row.id],
  );
  if ((u.rowCount ?? 0) === 0) return null; // raced consumption
  return { userId: row.user_id as string, purpose: row.purpose as VerifyPurpose };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Sends the verification email. In mock mode (no SMTP) this logs instead of sending. */
export async function sendVerificationEmail(toEmail: string, name: string, rawToken: string): Promise<void> {
  const url = `${config.appUrl}/verify-email?token=${encodeURIComponent(rawToken)}`;
  const safeName = escapeHtml(name || toEmail);
  await getNotify().sendEmail(
    toEmail,
    'Verify your Beyonix SEO email address',
    `<p>Hi ${safeName},</p>` +
      `<p>Please confirm your email address by clicking the link below (expires in 24 hours):</p>` +
      `<p><a href="${url}">Verify my email</a></p>` +
      `<p>If you didn't create a Beyonix SEO account, you can ignore this email.</p>`,
  );
}
