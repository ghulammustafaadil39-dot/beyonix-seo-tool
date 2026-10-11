-- Wave 2 / C-06 (Backend-A): data lifecycle.
-- Soft-delete for sites, EXPLAIN-verified hot-query indexes, retention
-- policy table (cleanup jobs read this).

-- Soft-delete: deleted sites are hidden everywhere but restorable for
-- 30 days (deleted_at + restore window); the hard-purge job deletes them.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Hot-query indexes (verified with EXPLAIN ANALYZE during C-06):
-- usage_events windowed sums per tenant/type/period
CREATE INDEX IF NOT EXISTS usage_events_tenant_type_created_idx
  ON usage_events (tenant_id, event_type, created_at DESC);
-- audit issue listing per audit
CREATE INDEX IF NOT EXISTS audit_issues_audit_idx
  ON audit_issues (audit_id, severity);
-- rank history per keyword (latest-first)
CREATE INDEX IF NOT EXISTS rank_checks_keyword_checked_idx
  ON rank_checks (keyword_id, checked_at DESC);
-- geo checks per site
CREATE INDEX IF NOT EXISTS geo_checks_site_idx
  ON geo_checks (site_id, checked_at DESC);
-- backlinks per site
CREATE INDEX IF NOT EXISTS backlinks_site_status_idx
  ON backlinks (site_id, status);
-- content listing per site
CREATE INDEX IF NOT EXISTS content_pieces_site_idx
  ON content_pieces (site_id, updated_at DESC);
-- reports per site
CREATE INDEX IF NOT EXISTS reports_site_idx
  ON reports (site_id, created_at DESC);
-- keywords per site (tracked filter for scheduler)
CREATE INDEX IF NOT EXISTS keywords_site_tracked_idx
  ON keywords (site_id, tracked);
-- verified-site scans for the scheduler
CREATE INDEX IF NOT EXISTS sites_verified_idx
  ON sites (verified) WHERE verified = TRUE AND deleted_at IS NULL;

-- Retention policies: entity -> keep-for interval. The retention cleanup job
-- (services/retention.ts) deletes rows older than keep_for where the table
-- exists. Defaults match the C-06 policy; adjustable at runtime.
CREATE TABLE IF NOT EXISTS retention_policies (
  entity TEXT PRIMARY KEY,      -- e.g. 'usage_events', 'audit_issues'
  keep_for INTERVAL NOT NULL,
  description TEXT
);
INSERT INTO retention_policies (entity, keep_for, description) VALUES
  ('usage_events',     interval '13 months', 'Billing evidence: current + 1 full prior year'),
  ('audit_issues',     interval '12 months', 'Issue history for regression comparison'),
  ('audits',           interval '12 months', 'Audit runs'),
  ('rank_checks',      interval '13 months', 'Rank history for trend charts'),
  ('geo_checks',       interval '12 months', 'GEO check history'),
  ('provider_spend',   interval '13 months', 'Spend evidence for invoicing disputes'),
  ('webhook_deliveries', interval '90 days', 'Webhook delivery attempts'),
  ('dead_letter_jobs', interval '90 days',  'Failed-job evidence'),
  ('notification_log', interval '12 months', 'Notification audit trail'),
  ('activity_log',     interval '24 months', 'Agency/team activity audit trail'),
  ('api_request_log',  interval '30 days',  'API request log (when enabled)')
ON CONFLICT (entity) DO NOTHING;
