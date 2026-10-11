-- Wave 2 / C-02 (Backend-A): metering correctness.
-- Reserve-then-commit ledger (kills the check-then-act race, N-A2-4),
-- usage-alert state for 80%/100% hooks, per-tenant provider spend.

-- Reservations: reserveUsage() inserts 'reserved' (expires_at = now+15min);
-- commitUsage() flips to 'committed'; cancelUsage() flips to 'cancelled'.
-- Usage sums count committed + unexpired reserved rows, so concurrent
-- callers cannot overspend the limit.
CREATE TABLE IF NOT EXISTS usage_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  units INT NOT NULL CHECK (units > 0),
  status TEXT NOT NULL DEFAULT 'reserved', -- reserved|committed|cancelled
  site_id UUID REFERENCES sites(id) ON DELETE SET NULL,
  meta JSONB,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '15 minutes',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_reservations_tenant_idx
  ON usage_reservations (tenant_id, event_type, status, expires_at);

-- 80%/100% alert state per tenant/kind/billing-period so hooks fire once.
CREATE TABLE IF NOT EXISTS usage_alert_state (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  alert_80_at TIMESTAMPTZ,
  alert_100_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, kind, period_start)
);

-- Per-tenant provider spend (DataForSEO cost tracking, C-02).
CREATE TABLE IF NOT EXISTS provider_spend (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,   -- e.g. 'dataforseo'
  feature TEXT NOT NULL,     -- e.g. 'keyword_metrics', 'serp'
  units INT NOT NULL DEFAULT 1,
  cost_cents INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_spend_tenant_idx
  ON provider_spend (tenant_id, provider, created_at DESC);
