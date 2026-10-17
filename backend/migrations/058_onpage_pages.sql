-- Phase 8: Onpage auto per-page — persist richer per-page crawl data in audit_pages
-- so the Onpage tab can analyze pages from the audit crawl without re-fetching.

ALTER TABLE audit_pages
  ADD COLUMN IF NOT EXISTS meta_description TEXT,
  ADD COLUMN IF NOT EXISTS h1s JSONB,
  ADD COLUMN IF NOT EXISTS robots_noindex BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS schema_types JSONB,
  ADD COLUMN IF NOT EXISTS has_og_tags BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS has_faq_schema BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS has_article_schema BOOLEAN NOT NULL DEFAULT FALSE;
