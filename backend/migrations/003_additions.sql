-- Location-aware rank tracking + keyword metrics; report dedupe; token revocation.

-- Per-site SERP location (DataForSEO location_code). Default 2840 = United States.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS serp_location_code INT DEFAULT 2840;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS serp_location_name TEXT DEFAULT 'United States';

-- Make the keyword metrics cache location-aware (was keyed by keyword alone,
-- so US and UK volumes for the same keyword would collide).
ALTER TABLE keyword_metrics_cache ADD COLUMN IF NOT EXISTS location_code INT DEFAULT 2840;
ALTER TABLE keyword_metrics_cache DROP CONSTRAINT IF EXISTS keyword_metrics_cache_pkey;
DELETE FROM keyword_metrics_cache a USING keyword_metrics_cache b
  WHERE a.keyword = b.keyword AND a.location_code = b.location_code AND a.fetched_at < b.fetched_at;
ALTER TABLE keyword_metrics_cache ADD PRIMARY KEY (keyword, location_code);

-- Report idempotency at the DB level (scheduler + manual generate race).
-- NOTE: Postgres has no "ADD CONSTRAINT IF NOT EXISTS"; the DO block below is
-- the idempotent equivalent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_site_period_unique') THEN
    ALTER TABLE reports ADD CONSTRAINT reports_site_period_unique UNIQUE (site_id, period_start);
  END IF;
END $$;

-- Token version for logout/session revocation (bumped on logout).
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT DEFAULT 0;
