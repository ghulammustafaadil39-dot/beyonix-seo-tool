-- 025_backlinks_v2.sql — Backend-B (F-06)
-- Backlinks v2: anchor text, heuristic toxic-link flags, link opportunities.

ALTER TABLE backlinks ADD COLUMN IF NOT EXISTS anchor_text TEXT;
ALTER TABLE backlinks ADD COLUMN IF NOT EXISTS toxic_flags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE backlinks ADD COLUMN IF NOT EXISTS toxic_score INT NOT NULL DEFAULT 0;
ALTER TABLE backlinks ADD COLUMN IF NOT EXISTS referring_domain TEXT;
CREATE INDEX IF NOT EXISTS idx_backlinks_toxic ON backlinks(site_id, toxic_score DESC) WHERE status = 'active';

-- F-06: link-opportunity finder results (unlinked mentions + competitor gap).
CREATE TABLE IF NOT EXISTS link_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, source_url, kind)
);
CREATE INDEX IF NOT EXISTS idx_link_opps_site ON link_opportunities(site_id);
