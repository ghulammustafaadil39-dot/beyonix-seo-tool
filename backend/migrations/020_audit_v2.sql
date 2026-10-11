-- 020_audit_v2.sql — Backend-B (C-04 / F-02)
-- Audit v2 engine: per-page records, impact scoring, crawl-change history,
-- issue states open|ignored|resolved|wont-fix ('fixed' -> 'resolved'),
-- crawl resume state, per-site scheduled crawl frequency.

-- F-02: issue lifecycle states. Existing 'fixed' rows become 'resolved'.
UPDATE audit_issues SET status = 'resolved' WHERE status = 'fixed';

-- F-02: impact-based prioritization (severity weight x page importance).
ALTER TABLE audit_issues ADD COLUMN IF NOT EXISTS impact INT NOT NULL DEFAULT 0;

-- C-04: resumable crawls — the worker persists {visited, queue, done} here.
ALTER TABLE audits ADD COLUMN IF NOT EXISTS crawl_state JSONB;

-- F-02: scheduled crawls per plan (scheduler hook reads this column).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS crawl_schedule TEXT NOT NULL DEFAULT 'weekly';

-- C-04/F-02: one row per crawled page — powers per-page detail, orphan
-- detection, internal-link graph, simhash dupes, incremental recrawl.
CREATE TABLE IF NOT EXISTS audit_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  audit_id UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status_code INT NOT NULL DEFAULT 0,
  title TEXT,
  word_count INT NOT NULL DEFAULT 0,
  load_ms INT NOT NULL DEFAULT 0,
  etag TEXT,
  last_modified TEXT,
  canonical TEXT,
  hreflangs JSONB,
  inlinks INT NOT NULL DEFAULT 0,
  outlinks JSONB,
  simhash TEXT,
  depth INT NOT NULL DEFAULT 0,
  redirect_hops INT NOT NULL DEFAULT 0,
  images JSONB,
  reused_conditional BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audit_id, url)
);
CREATE INDEX IF NOT EXISTS idx_audit_pages_site_audit ON audit_pages(site_id, audit_id);
CREATE INDEX IF NOT EXISTS idx_audit_pages_tenant ON audit_pages(tenant_id, site_id);

-- F-02: change history between consecutive crawls.
CREATE TABLE IF NOT EXISTS audit_diffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  audit_id UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  prev_audit_id UUID REFERENCES audits(id) ON DELETE SET NULL,
  new_issues INT NOT NULL DEFAULT 0,
  resolved_issues INT NOT NULL DEFAULT 0,
  new_errors INT NOT NULL DEFAULT 0,
  by_type JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_diffs_audit ON audit_diffs(audit_id);
