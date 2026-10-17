-- 053: outreach — backlink outreach prospecting + campaigns (Phase 2 rebuild).
-- PRIMARY backlink workflow (per locked spec): find prospects -> personalize
-- pitches -> send -> track. No paid APIs. Upload stays as secondary option.

CREATE TABLE IF NOT EXISTS outreach_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outreach_camp_site ON outreach_campaigns(site_id, status);

CREATE TABLE IF NOT EXISTS outreach_prospects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES outreach_campaigns(id) ON DELETE SET NULL,
  prospect_domain TEXT NOT NULL,
  prospect_url TEXT NOT NULL,
  prospect_type TEXT NOT NULL CHECK (prospect_type IN ('resource_page', 'guest_post', 'broken_link', 'unlinked_mention', 'reclaim')),
  contact_email TEXT,
  -- Link Building specialist spec: score prospects, reject < 50.
  score INT NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'pitched', 'replied', 'won', 'lost', 'rejected')),
  pitch_subject TEXT,
  pitch_body TEXT,
  -- Personalization hard gate: >= 3 prospect-specific fields stored as JSON.
  personalization_fields JSONB NOT NULL DEFAULT '{}',
  reason TEXT,
  sent_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  followup_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, prospect_url)
);
CREATE INDEX IF NOT EXISTS idx_outreach_prosp_site ON outreach_prospects(site_id, status);
CREATE INDEX IF NOT EXISTS idx_outreach_prosp_tenant ON outreach_prospects(tenant_id, site_id);
CREATE INDEX IF NOT EXISTS idx_outreach_prosp_sent ON outreach_prospects(site_id, sent_at);
