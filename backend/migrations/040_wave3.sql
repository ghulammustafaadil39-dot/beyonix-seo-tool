-- 040_wave3.sql — Backend Lead Wave 3 (W-01..W-08 backend)
-- Additive only. New tenant table: NONE (no new tenant-owned tables in this
-- migration, so SHELL_TENANT_TABLES needs no addition for 040).

-- W-02: provenance on the shared provider caches. Every cached row records
-- WHICH provider produced it; TTL stays code-level per data type
-- (keyword metrics 30d, SERP 7d — see services/keywordCache.ts).
ALTER TABLE keyword_metrics_cache ADD COLUMN IF NOT EXISTS source_provider TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE serp_cache ADD COLUMN IF NOT EXISTS source_provider TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE serp_snapshots ADD COLUMN IF NOT EXISTS source_provider TEXT NOT NULL DEFAULT 'unknown';

-- W-02: anomaly flags on rank alerts (z-score vs rolling history).
ALTER TABLE rank_alerts ADD COLUMN IF NOT EXISTS anomaly BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE rank_alerts ADD COLUMN IF NOT EXISTS z_score DOUBLE PRECISION;
ALTER TABLE rank_alerts ADD COLUMN IF NOT EXISTS anomaly_reason TEXT;

-- W-03: per-tenant LLM cost cap, in ai_words per billing window.
-- NULL = no tenant-specific cap (plan ai_words limit still applies).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS llm_cost_cap_words INT;

-- W-08: hot-read indexes.
CREATE INDEX IF NOT EXISTS idx_w3_rank_checks_kw_latest ON rank_checks (tenant_id, keyword_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_w3_audits_site_latest ON audits (tenant_id, site_id, finished_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_w3_audit_issues_site_status ON audit_issues (tenant_id, site_id, status, severity);
CREATE INDEX IF NOT EXISTS idx_w3_keywords_site_tracked ON keywords (tenant_id, site_id, tracked);
CREATE INDEX IF NOT EXISTS idx_w3_provider_spend_day ON provider_spend (created_at);
CREATE INDEX IF NOT EXISTS idx_w3_usage_tenant_type_time ON usage_events (tenant_id, event_type, created_at);
