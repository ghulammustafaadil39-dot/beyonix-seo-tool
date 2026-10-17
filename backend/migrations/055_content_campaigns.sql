-- Phase 4: content campaigns + topics.
-- content_campaigns: client sets a publishing campaign (weekly/monthly blog
-- count, mode). Mode 'autopilot' auto-publishes written pieces; 'approval'
-- keeps 2-3 options ready for the client to pick.
-- campaign_topics: topic pipeline — suggested (by ai or user) → approved →
-- written. suggested_by distinguishes proactive AI suggestions from manual adds.

CREATE TABLE IF NOT EXISTS content_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  blogs_per_week INT NOT NULL DEFAULT 1 CHECK (blogs_per_week BETWEEN 0 AND 7),
  blogs_per_month INT NOT NULL DEFAULT 4 CHECK (blogs_per_month BETWEEN 0 AND 31),
  mode TEXT NOT NULL DEFAULT 'approval' CHECK (mode IN ('autopilot', 'approval')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_campaigns_site ON content_campaigns(site_id);

CREATE TABLE IF NOT EXISTS campaign_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES content_campaigns(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  keyword TEXT,
  status TEXT NOT NULL DEFAULT 'suggested'
    CHECK (status IN ('suggested', 'approved', 'rejected', 'written')),
  suggested_by TEXT NOT NULL DEFAULT 'ai' CHECK (suggested_by IN ('ai', 'user')),
  reason TEXT,
  content_piece_id UUID REFERENCES content_pieces(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_campaign_topics_campaign ON campaign_topics(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_topics_site_status ON campaign_topics(site_id, status);
-- One topic text per campaign (case-insensitive) to avoid duplicate suggestions.
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_topics_campaign_topic
  ON campaign_topics(campaign_id, lower(topic));
