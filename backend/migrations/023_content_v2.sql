-- 023_content_v2.sql — Backend-B (F-04)
-- Content engine v2: version history, per-site brand-voice profiles.

-- F-04: every write to a content piece appends a version (approval audit trail).
CREATE TABLE IF NOT EXISTS content_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  piece_id UUID NOT NULL REFERENCES content_pieces(id) ON DELETE CASCADE,
  title TEXT,
  outline TEXT,
  draft TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  changed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_versions_piece ON content_versions(piece_id, created_at);

-- F-04: tone & brand-voice profile per site (feeds the content prompts).
CREATE TABLE IF NOT EXISTS content_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  site_id UUID NOT NULL UNIQUE REFERENCES sites(id) ON DELETE CASCADE,
  tone TEXT,
  vocabulary TEXT,
  do_rules TEXT,
  dont_rules TEXT,
  sample TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
