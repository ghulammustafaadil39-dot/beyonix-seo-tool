-- 027_crawl_v2.sql — Backend-B (C-04)
-- Crawler quality: PageSpeed cache with quotas, daily provider quotas.

-- C-04: PageSpeed results cached 7 days (quotas below protect the free tier).
CREATE TABLE IF NOT EXISTS pagespeed_cache (
  url TEXT PRIMARY KEY,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metrics JSONB NOT NULL
);

-- C-04: daily call quotas for provider-backed services (pagespeed, etc.).
CREATE TABLE IF NOT EXISTS daily_quotas (
  quota_key TEXT NOT NULL,
  day DATE NOT NULL,
  count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (quota_key, day)
);
