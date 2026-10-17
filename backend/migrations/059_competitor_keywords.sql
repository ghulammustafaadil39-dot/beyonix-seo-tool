-- Migration 059: competitor_keywords table
-- Stores per-keyword competitor gap data so Phase 4 topic suggestions can use it.
CREATE TABLE IF NOT EXISTS competitor_keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  competitor_domain TEXT NOT NULL,
  competitor_position INTEGER,
  site_position INTEGER,
  volume INTEGER,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, keyword, competitor_domain)
);
CREATE INDEX IF NOT EXISTS idx_competitor_keywords_site ON competitor_keywords(site_id);
