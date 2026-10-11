-- 026_reports_v2.sql — Backend-B (F-02 share links, F-08 white-label reports)
-- Shareable signed links, white-label branding, scheduled email delivery.

-- F-08: white-label branding per tenant (logo + colors for PDF/HTML reports).
CREATE TABLE IF NOT EXISTS tenant_branding (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  company_name TEXT,
  logo_url TEXT,
  primary_color TEXT,
  accent_color TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- F-08: scheduled report email delivery (scheduler hook reads enabled rows).
CREATE TABLE IF NOT EXISTS report_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  site_id UUID NOT NULL UNIQUE REFERENCES sites(id) ON DELETE CASCADE,
  frequency TEXT NOT NULL DEFAULT 'weekly',
  recipients TEXT[] NOT NULL DEFAULT '{}',
  sections TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- F-02/F-08: signed share-link records. The token itself is an HMAC over
-- (resource_type, resource_id, tenant_id, expiry) — the DB only stores the
-- hash for revocation listing; verification is stateless.
CREATE TABLE IF NOT EXISTS share_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_share_tokens_resource ON share_tokens(resource_type, resource_id);

-- F-08: custom report sections + comparison data baked into the report row.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS sections TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS branding JSONB;
