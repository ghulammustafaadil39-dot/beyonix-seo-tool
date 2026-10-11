-- Wave 2 / C-07 (Backend-A): idempotency keys for POSTs that create paid
-- work. The key (client-supplied via `Idempotency-Key` header) is scoped per
-- tenant; a replayed request with the same key AND the same request hash
-- returns the stored response instead of re-executing.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,               -- e.g. 'billing:checkout'
  request_hash TEXT NOT NULL,        -- sha256 of method+path+body
  response JSONB,
  status_code INT,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx
  ON idempotency_keys (created_at);
