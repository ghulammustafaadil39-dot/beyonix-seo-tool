// S-05: TOTP 2FA (RFC 6238) via otplib (v13 functional API).
//
// Secrets are stored encrypted (crypto.ts); only otpauth URLs / base32
// secrets cross the wire at setup time, shown once. Verification allows ±30s
// of clock drift (epochTolerance). Backup codes are single-use SHA-256 hashes.
import { createHash, randomBytes } from 'node:crypto';
import { generate, generateSecret, generateURI, verify } from 'otplib';
import { decrypt, encrypt } from '../crypto.js';
import { query } from '../db.js';

export const BACKUP_CODE_COUNT = 10;
/** ±30s clock drift tolerance on verification. */
const EPOCH_TOLERANCE = 30;

export function generateTotpSecret(): string {
  return generateSecret();
}

export function totpAuthUrl(secret: string, email: string): string {
  return generateURI({ issuer: 'Beyonix SEO', label: email, secret });
}

/** Generates the current TOTP code (used by tests; real users use their app). */
export async function generateTotpCode(secret: string): Promise<string> {
  return generate({ secret });
}

export async function verifyTotpCode(secret: string, code: string): Promise<boolean> {
  try {
    const res = await verify({ secret, token: (code ?? '').trim(), epochTolerance: EPOCH_TOLERANCE });
    return res.valid === true;
  } catch {
    return false;
  }
}

/** One-time backup codes (returned once at enable time). */
export function generateBackupCodes(): string[] {
  return Array.from({ length: BACKUP_CODE_COUNT }, () => randomBytes(6).toString('hex'));
}

export function hashBackupCode(code: string): string {
  return createHash('sha256').update((code ?? '').trim().toLowerCase(), 'utf8').digest('hex');
}

export async function getTotpState(userId: string): Promise<{
  enabled: boolean;
  hasPendingSecret: boolean;
}> {
  const r = await query('SELECT totp_secret_enc, totp_enabled_at FROM users WHERE id = $1', [userId]);
  const row = r.rows[0];
  return {
    enabled: row?.totp_enabled_at != null,
    hasPendingSecret: !!row?.totp_secret_enc && row?.totp_enabled_at == null,
  };
}

/** Stores a fresh (not yet enabled) secret; returns it for the QR/otpauth step. */
export async function beginTotpSetup(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
  const secret = generateTotpSecret();
  const r = await query('SELECT email FROM users WHERE id = $1', [userId]);
  const email = (r.rows[0]?.email as string) ?? 'user';
  await query('UPDATE users SET totp_secret_enc = $1, totp_enabled_at = NULL WHERE id = $2', [
    encrypt(secret),
    userId,
  ]);
  return { secret, otpauthUrl: totpAuthUrl(secret, email) };
}

/**
 * Verifies the code against the pending secret; on success enables 2FA and
 * mints backup codes (returned ONCE — store the hashes only).
 */
export async function enableTotp(userId: string, code: string): Promise<string[] | null> {
  const r = await query('SELECT totp_secret_enc, totp_enabled_at FROM users WHERE id = $1', [userId]);
  const row = r.rows[0];
  if (!row?.totp_secret_enc || row.totp_enabled_at) return null;
  const secret = decrypt(row.totp_secret_enc as string);
  if (!(await verifyTotpCode(secret, code))) return null;
  const codes = generateBackupCodes();
  await query('UPDATE users SET totp_enabled_at = now(), totp_backup_codes = $2 WHERE id = $1', [
    userId,
    codes.map(hashBackupCode),
  ]);
  return codes;
}

/** Disables 2FA (clears secret, timestamp, backup codes). */
export async function disableTotp(userId: string): Promise<void> {
  await query(
    'UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_backup_codes = NULL WHERE id = $1',
    [userId],
  );
}

/** Verifies a TOTP code OR consumes a one-time backup code. */
export async function verifyTotpOrBackup(userId: string, code: string): Promise<boolean> {
  const r = await query(
    'SELECT totp_secret_enc, totp_enabled_at, totp_backup_codes FROM users WHERE id = $1',
    [userId],
  );
  const row = r.rows[0];
  if (!row?.totp_enabled_at || !row?.totp_secret_enc) return false;
  const secret = decrypt(row.totp_secret_enc as string);
  if (await verifyTotpCode(secret, code)) return true;
  const hash = hashBackupCode(code);
  const codes = (row.totp_backup_codes as string[] | null) ?? [];
  if (!codes.includes(hash)) return false;
  // Single-use: remove the consumed code atomically.
  const u = await query(
    `UPDATE users SET totp_backup_codes = array_remove(totp_backup_codes, $2)
     WHERE id = $1 AND $2 = ANY (totp_backup_codes)`,
    [userId, hash],
  );
  return (u.rowCount ?? 0) > 0;
}

/** True when the account has 2FA enabled. */
export async function isTotpEnabled(userId: string): Promise<boolean> {
  const r = await query('SELECT totp_enabled_at FROM users WHERE id = $1', [userId]);
  return r.rows[0]?.totp_enabled_at != null;
}
