-- Audit additions: keyword topic grouping (cannibalization avoidance).
ALTER TABLE keywords ADD COLUMN IF NOT EXISTS group_key TEXT;
CREATE INDEX IF NOT EXISTS idx_keywords_site_group ON keywords(site_id, group_key);
