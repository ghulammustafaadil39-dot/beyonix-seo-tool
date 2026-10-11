-- Wave 2 / F-09 (Backend-A): agency & team.
-- Roles (owner/admin/editor/viewer) live on users.role (existing column).
-- Client workspaces sit under one agency tenant; workspace isolation is
-- enforced by (tenant_id, workspace_id) scoping on every workspace query.

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Per-client limits override the tenant plan (F-09). Null = plan default.
  limits JSONB,                       -- { max_sites, max_keywords_tracked, ... }
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS workspaces_tenant_idx ON workspaces (tenant_id);

-- Sites can be assigned to a client workspace (nullable = agency-level).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS sites_workspace_idx ON sites (workspace_id);

-- Team invitations by email: token stored as sha256 hash, 7-day expiry.
CREATE TABLE IF NOT EXISTS team_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email CITEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor', -- admin|editor|viewer (never owner via invite)
  token_hash TEXT NOT NULL UNIQUE,
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_invitations_tenant_idx
  ON team_invitations (tenant_id, email);

-- Agency/team activity log (F-09). 24-month retention per 013 policy.
CREATE TABLE IF NOT EXISTS activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  action TEXT NOT NULL,               -- e.g. 'site.created', 'invite.accepted'
  entity_type TEXT,
  entity_id TEXT,
  meta JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_log_tenant_idx
  ON activity_log (tenant_id, created_at DESC);
