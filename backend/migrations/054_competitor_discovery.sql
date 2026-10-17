-- Phase 3: competitor auto-discovery columns.
-- discovery_source: 'auto' (found by SERP discovery) or 'manual' (user added).
-- overlap_score 0-100: how much the competitor overlaps the site's keywords.
-- shared_keywords: count of site keywords where competitor ranks top 10.
-- avg_position: competitor's average position across shared keywords.

ALTER TABLE competitors
  ADD COLUMN IF NOT EXISTS discovery_source TEXT NOT NULL DEFAULT 'manual'
    CHECK (discovery_source IN ('auto', 'manual')),
  ADD COLUMN IF NOT EXISTS overlap_score DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS shared_keywords INT,
  ADD COLUMN IF NOT EXISTS avg_position DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS last_discovered_at TIMESTAMPTZ;
