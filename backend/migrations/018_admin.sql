-- Wave 2 / F-14 (Backend-A): admin back-office.
-- Platform-admin flag, suspensions, admin audit log, feature flags, credits.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

-- Every admin action (incl. impersonation) is audit-logged (W-07 / F-14).
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  action TEXT NOT NULL,               -- e.g. 'tenant.suspend', 'impersonate'
  target_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  meta JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx
  ON admin_audit_log (created_at DESC);

-- Feature flags (F-14).
CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Manual refund/credit notes (F-14 helper). Credits reduce the next invoice
-- amount in the mock ledger; with real Stripe the admin applies the
-- equivalent credit in the Stripe dashboard and records the note here.
CREATE TABLE IF NOT EXISTS tenant_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  amount_cents INT NOT NULL,
  reason TEXT NOT NULL,
  applied_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_credits_tenant_idx
  ON tenant_credits (tenant_id, created_at DESC);
