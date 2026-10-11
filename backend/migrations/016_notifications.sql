-- Wave 2 / F-10 (Backend-A): notifications.
-- Per-user alert rules, digest settings, webhook endpoints with signed
-- delivery + retries + replay, notification log.

-- Alert rules: rank_drop, critical_issue, site_down, limit_near.
CREATE TABLE IF NOT EXISTS notification_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL,            -- rank_drop|critical_issue|site_down|limit_near
  channels TEXT[] NOT NULL DEFAULT '{}', -- email|telegram|slack|webhook|inapp
  config JSONB NOT NULL DEFAULT '{}',    -- e.g. { drop_positions: 5, site_id }
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, user_id, rule_type)
);

-- Digest settings per user.
CREATE TABLE IF NOT EXISTS notification_digests (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  frequency TEXT NOT NULL DEFAULT 'weekly', -- daily|weekly|off
  channels TEXT[] NOT NULL DEFAULT '{email}',
  last_sent_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, user_id)
);

-- Outbound webhook endpoints (customer-configured). URL + secret never
-- leave the tenant scope; secrets stored encrypted via crypto (kid).
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret_enc TEXT NOT NULL,           -- HMAC signing secret (encrypted)
  events TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_tenant_idx
  ON webhook_endpoints (tenant_id);

-- Delivery attempts per endpoint/event with retry state.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|delivered|failed
  attempts INT NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  last_error TEXT,
  last_status_code INT,
  created_at TIMESTAMPTZ DEFAULT now(),
  delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_retry_idx
  ON webhook_deliveries (status, next_retry_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS webhook_deliveries_tenant_idx
  ON webhook_deliveries (tenant_id, created_at DESC);

-- Notification audit trail (what was sent, to whom, on which channel).
CREATE TABLE IF NOT EXISTS notification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  rule_id UUID REFERENCES notification_rules(id) ON DELETE SET NULL,
  notification_type TEXT NOT NULL,
  channel TEXT NOT NULL,              -- email|telegram|slack|webhook|inapp
  status TEXT NOT NULL,               -- sent|failed|skipped
  detail TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_log_tenant_idx
  ON notification_log (tenant_id, created_at DESC);
