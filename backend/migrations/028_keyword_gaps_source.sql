-- 028_keyword_gaps_source.sql — Backend-B (F-03)
-- Honest data-source labeling for cached keyword gaps.
ALTER TABLE keyword_gaps ADD COLUMN IF NOT EXISTS data_source TEXT NOT NULL DEFAULT 'mock';
