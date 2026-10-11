-- 022_keyword_v2.sql — Backend-B (F-03)
-- Keyword v2: named lists with tags, gap-analysis result cache.

CREATE TABLE IF NOT EXISTS keyword_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, name)
);
CREATE INDEX IF NOT EXISTS idx_keyword_lists_site ON keyword_lists(site_id);

CREATE TABLE IF NOT EXISTS keyword_list_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  list_id UUID NOT NULL REFERENCES keyword_lists(id) ON DELETE CASCADE,
  keyword_id UUID NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (list_id, keyword_id)
);
CREATE INDEX IF NOT EXISTS idx_keyword_list_members_list ON keyword_list_members(list_id);

-- F-03: cached competitor keyword-gap results (expensive provider call).
CREATE TABLE IF NOT EXISTS keyword_gaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  competitor_domain TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  gaps JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (site_id, competitor_domain)
);
