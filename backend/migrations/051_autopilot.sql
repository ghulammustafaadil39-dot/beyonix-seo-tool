-- Autopilot v2.0: WordPress connections, settings, and change log.
-- Every automated change is recorded here with its previous value for
-- one-click undo (30-day retention).

-- WordPress site connections (one per site). Credentials encrypted.
CREATE TABLE IF NOT EXISTS wp_connections (
  site_id UUID PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_url TEXT NOT NULL,
  wp_username TEXT NOT NULL,
  app_password_enc TEXT NOT NULL,
  seo_plugin TEXT NOT NULL DEFAULT 'none', -- yoast | rankmath | both | none
  status TEXT NOT NULL DEFAULT 'active',   -- active | error | revoked
  last_check_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Autopilot settings per site.
CREATE TABLE IF NOT EXISTS autopilot_settings (
  site_id UUID PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'copilot', -- copilot (approval) | autopilot (full auto)
  enabled BOOLEAN NOT NULL DEFAULT true,
  max_changes_per_run INT NOT NULL DEFAULT 20,
  max_changes_per_day INT NOT NULL DEFAULT 50,
  max_posts_per_week INT NOT NULL DEFAULT 2,
  auto_publish_cooling_hours INT NOT NULL DEFAULT 24,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Change log: every autopilot/co-pilot change, with previous value for undo.
CREATE TABLE IF NOT EXISTS site_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wp_post_id INT,
  change_type TEXT NOT NULL, -- meta_description | title | alt_text | post_created | ...
  field_key TEXT,            -- e.g. _yoast_wpseo_metadesc
  previous_value TEXT,
  new_value TEXT,
  page_url TEXT,
  status TEXT NOT NULL DEFAULT 'applied', -- proposed | approved | applied | failed | reverted
  mode TEXT NOT NULL, -- copilot | autopilot
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ,
  reverted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS site_changes_site_idx ON site_changes(site_id, created_at DESC);

-- Approval queue for co-pilot mode.
CREATE TABLE IF NOT EXISTS autopilot_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  change_type TEXT NOT NULL,
  field_key TEXT,
  wp_post_id INT,
  page_url TEXT,
  previous_value TEXT,
  proposed_value TEXT,
  reason TEXT NOT NULL, -- plain-language explanation for the non-tech user
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | expired
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS autopilot_proposals_site_idx
  ON autopilot_proposals(site_id, status, created_at DESC);
