-- 024_geo_v2.sql — Backend-B (F-05)
-- GEO v2: per-site prompt sets; richer check records (sentiment, citations,
-- simulated flag with engine version).

-- F-05: prompt sets per site — the same prompts are run on every engine.
CREATE TABLE IF NOT EXISTS geo_prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, prompt)
);
CREATE INDEX IF NOT EXISTS idx_geo_prompts_site ON geo_prompts(site_id);

-- F-05: richer per-check records.
ALTER TABLE geo_checks ADD COLUMN IF NOT EXISTS sentiment TEXT;
ALTER TABLE geo_checks ADD COLUMN IF NOT EXISTS citations JSONB;
ALTER TABLE geo_checks ADD COLUMN IF NOT EXISTS simulated BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE geo_checks ADD COLUMN IF NOT EXISTS engine_version TEXT;
CREATE INDEX IF NOT EXISTS idx_geo_checks_site_platform ON geo_checks(site_id, platform, checked_at);
