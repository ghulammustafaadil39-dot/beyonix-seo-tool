-- 006_account_security.sql — S-05: account lifecycle hardening.
--
-- * TOTP 2FA columns on users (secret stored encrypted, backup codes hashed).
-- * user_sessions: server-side session registry backing the session list,
--   per-session revocation, and "log out everywhere". JWTs carry a jti;
--   only its SHA-256 ever touches the DB.
CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jti_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT[];
