-- 052: keyword_suggestions — auto-suggested keywords (Phase 1 rebuild).
-- Suggestions are generated from GSC queries + site content (both free),
-- deduped against tracked keywords. User approves → becomes tracked keyword.

CREATE TABLE IF NOT EXISTS keyword_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('gsc', 'content')),
  score DOUBLE PRECISION NOT NULL DEFAULT 0,
  reason TEXT,
  impressions INT,
  position DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  UNIQUE (site_id, keyword)
);
CREATE INDEX IF NOT EXISTS idx_kw_sugg_site ON keyword_suggestions(site_id, status);
CREATE INDEX IF NOT EXISTS idx_kw_sugg_tenant ON keyword_suggestions(tenant_id, site_id);
