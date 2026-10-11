-- Wave 2 / C-03 (Backend-A): dead-letter queue backing table.

CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue TEXT NOT NULL,
  job_name TEXT NOT NULL,
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  error TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|replayed|discarded
  failed_at TIMESTAMPTZ DEFAULT now(),
  replayed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS dead_letter_jobs_status_idx
  ON dead_letter_jobs (status, failed_at DESC);
CREATE INDEX IF NOT EXISTS dead_letter_jobs_tenant_idx
  ON dead_letter_jobs (tenant_id);
