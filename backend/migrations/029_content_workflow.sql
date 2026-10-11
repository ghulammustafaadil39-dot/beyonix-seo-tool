-- 029_content_workflow.sql — Backend-B (F-04)
-- Content engine v2: brief + tone on pieces (brief -> outline -> draft workflow).
ALTER TABLE content_pieces ADD COLUMN IF NOT EXISTS brief TEXT;
ALTER TABLE content_pieces ADD COLUMN IF NOT EXISTS tone TEXT;
