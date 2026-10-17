-- Phase 5 (GEO readiness): AI-readiness audit history + check schedules.
-- Separate from geo_checks (LLM simulation rows) — this stores the FREE
-- readiness audit (llms.txt, robots.txt AI crawlers, schema, content).

CREATE TABLE IF NOT EXISTS geo_readiness (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  score INT NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  checks JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_geo_readiness_site ON geo_readiness(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_geo_readiness_tenant ON geo_readiness(tenant_id, site_id);

-- Per-site GEO check schedule (client-configurable: daily/weekly).
CREATE TABLE IF NOT EXISTS geo_schedules (
  site_id UUID PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  frequency TEXT NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('daily', 'weekly')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
