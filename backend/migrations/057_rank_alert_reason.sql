-- Phase 7 (Ranks tracking): beginner-friendly reason on rank alerts.
-- Explains WHY a keyword dropped (e.g. which competitor overtook it).

ALTER TABLE rank_alerts ADD COLUMN IF NOT EXISTS reason TEXT;
