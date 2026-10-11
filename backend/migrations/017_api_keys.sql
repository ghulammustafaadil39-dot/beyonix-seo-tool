-- Wave 2 / F-13 (Backend-A): public API keys.
-- Only the sha256 hash is stored; the raw key is shown ONCE at creation.

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,      -- sha256 hex of the raw key
  key_prefix TEXT NOT NULL,           -- first 8 chars, for support lookup
  scopes TEXT[] NOT NULL DEFAULT '{}',
  rate_limit_per_min INT NOT NULL DEFAULT 60,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys (tenant_id);
CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys (key_hash);
