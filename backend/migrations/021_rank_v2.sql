-- 021_rank_v2.sql — Backend-B (C-05 / F-07)
-- Rank tracking v2: full SERP snapshots (shared cross-tenant cache),
-- per-keyword device/location/language tracking configs, position-change
-- alerts, pixel rank, competitor table.

-- C-05: full SERP snapshots. GLOBAL cache (not tenant-scoped), like
-- serp_cache — the same keyword/location/device SERP is never bought twice.
CREATE TABLE IF NOT EXISTS serp_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key TEXT NOT NULL UNIQUE,
  keyword TEXT NOT NULL,
  location_code INT NOT NULL DEFAULT 2840,
  device TEXT NOT NULL DEFAULT 'desktop',
  language TEXT NOT NULL DEFAULT 'en',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  features JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_serp_snapshots_key ON serp_snapshots(cache_key);
CREATE INDEX IF NOT EXISTS idx_serp_snapshots_fetched ON serp_snapshots(fetched_at);

-- C-05: pixel rank (rank_absolute from the provider) + link to the snapshot.
ALTER TABLE rank_checks ADD COLUMN IF NOT EXISTS pixel_rank INT;
ALTER TABLE rank_checks ADD COLUMN IF NOT EXISTS snapshot_id UUID REFERENCES serp_snapshots(id) ON DELETE SET NULL;
ALTER TABLE rank_checks ADD COLUMN IF NOT EXISTS device TEXT NOT NULL DEFAULT 'desktop';
ALTER TABLE rank_checks ADD COLUMN IF NOT EXISTS location_code INT NOT NULL DEFAULT 2840;
ALTER TABLE rank_checks ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';

-- C-05: per-keyword tracking config (device/location/language).
CREATE TABLE IF NOT EXISTS rank_tracking_configs (
  keyword_id UUID PRIMARY KEY REFERENCES keywords(id) ON DELETE CASCADE,
  device TEXT NOT NULL DEFAULT 'desktop',
  location_code INT NOT NULL DEFAULT 2840,
  language TEXT NOT NULL DEFAULT 'en'
);

-- C-05: persisted position-change alerts (also feeds the F-10 rules hook).
CREATE TABLE IF NOT EXISTS rank_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  keyword_id UUID NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  prev_position INT,
  position INT,
  delta INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rank_alerts_kw ON rank_alerts(tenant_id, keyword_id, created_at);

-- Alert events outbox for the F-10 notification-rules engine (Backend-A).
-- Producers (rank jobs, crawl jobs) insert; the rules engine consumes.
CREATE TABLE IF NOT EXISTS alert_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  consumed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alert_events_tenant ON alert_events(tenant_id, consumed, created_at);

-- F-07: competitors tracked per site.
CREATE TABLE IF NOT EXISTS competitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, domain)
);
CREATE INDEX IF NOT EXISTS idx_competitors_site ON competitors(site_id);
