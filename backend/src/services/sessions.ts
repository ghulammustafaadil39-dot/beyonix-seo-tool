// S-05: server-side session registry.
//
// JWTs are stateless, but each carries a jti; only SHA-256(jti) is stored
// here. Powers the session list, per-session revocation, "log out
// everywhere", and automatic revocation on password change/reset.
import { createHash } from 'node:crypto';
import { query } from '../db.js';

export function hashJti(jti: string): string {
  return createHash('sha256').update(jti, 'utf8').digest('hex');
}

export interface SessionRow {
  id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_seen_at: string;
}

/** Records a new session for an issued token. Idempotent on jti_hash. */
export async function createSession(
  userId: string,
  jti: string,
  userAgent?: string,
  ip?: string,
): Promise<void> {
  await query(
    `INSERT INTO user_sessions (id, user_id, jti_hash, user_agent, ip)
     VALUES (gen_random_uuid(), $1, $2, $3, $4)
     ON CONFLICT (jti_hash) DO NOTHING`,
    [userId, hashJti(jti), userAgent ?? null, ip ?? null],
  );
}

/** True when the session exists and is not revoked. */
export async function isSessionActive(userId: string, jti: string): Promise<boolean> {
  const r = await query('SELECT revoked_at FROM user_sessions WHERE jti_hash = $1 AND user_id = $2', [
    hashJti(jti),
    userId,
  ]);
  return r.rows.length > 0 && r.rows[0].revoked_at == null;
}

/** Throttled last-seen touch (at most one write per 10 minutes per session). */
export async function touchSession(jti: string): Promise<void> {
  await query(
    `UPDATE user_sessions SET last_seen_at = now()
     WHERE jti_hash = $1 AND last_seen_at < now() - interval '10 minutes'`,
    [hashJti(jti)],
  );
}

export async function listSessions(userId: string): Promise<SessionRow[]> {
  const r = await query(
    `SELECT id, user_agent, ip, created_at, last_seen_at
     FROM user_sessions
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY last_seen_at DESC`,
    [userId],
  );
  return r.rows as SessionRow[];
}

/** Revokes one session. Returns false when it doesn't belong to the user. */
export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
  const r = await query(
    `UPDATE user_sessions SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [sessionId, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Revokes sessions for the user. Without exceptJti: revokes ALL sessions and
 * bumps token_version (so even session-less legacy tokens die) — used by
 * password change/reset and "log out everywhere". With exceptJti: revokes
 * every OTHER session but keeps token_version untouched so the surviving
 * session's token stays valid (used when enabling 2FA mid-session).
 */
export async function revokeAllSessions(userId: string, exceptJti?: string): Promise<void> {
  if (exceptJti) {
    await query(
      'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND jti_hash <> $2',
      [userId, hashJti(exceptJti)],
    );
    return;
  }
  await query('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
    userId,
  ]);
  await query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [userId]);
}
