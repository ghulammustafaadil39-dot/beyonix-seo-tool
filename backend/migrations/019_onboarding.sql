-- Wave 2 / F-01 sub-task (Backend-A): onboarding progress-state API.
-- One row per (tenant, site, step); the frontend checklist reads/writes this.

CREATE TABLE IF NOT EXISTS onboarding_state (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  step TEXT NOT NULL,                 -- verify_site|connect_gsc|first_crawl|add_keywords|first_report
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id, step)
);
