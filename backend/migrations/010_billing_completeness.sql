-- Wave 2 / C-01 (Backend-A): billing completeness.
-- Stripe webhook idempotency ledger, period/coupon/trial/dunning columns,
-- invoices ledger, coupon catalog, tenant read-only flag.

-- Idempotency ledger for Stripe webhooks (N-A2-6). Event ids are inserted
-- BEFORE processing; ON CONFLICT DO NOTHING makes redelivery a no-op.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- Period/coupon/trial/dunning columns on subscriptions. All dates come FROM
-- Stripe events (current_period_start/end); never now()+30d (C-01).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN DEFAULT FALSE;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_interval TEXT DEFAULT 'monthly';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS coupon_code TEXT;
-- Grace period: past_due subscriptions keep paid limits until grace_until,
-- then the daily billing job downgrades them (C-01 dunning + grace).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS grace_until TIMESTAMPTZ;

-- Invoice ledger: populated by invoice.paid / invoice.payment_failed /
-- charge.refunded events so the invoices list works with the mock provider
-- too (no Stripe API dependency at read time).
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_invoice_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  amount_due_cents INT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL, -- paid|open|failed|refunded|void
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  hosted_invoice_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoices_tenant_created_idx
  ON invoices (tenant_id, created_at DESC);

-- Coupon catalog for trials/coupons (F-11 backend). Mock provider validates
-- and records these locally; the real provider also attaches the Stripe
-- coupon/promotion code at checkout.
CREATE TABLE IF NOT EXISTS billing_coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  percent_off INT CHECK (percent_off IS NULL OR (percent_off > 0 AND percent_off <= 100)),
  amount_off_cents INT CHECK (amount_off_cents IS NULL OR amount_off_cents > 0),
  duration TEXT NOT NULL DEFAULT 'once', -- once|repeating|forever
  max_redemptions INT,
  redeemed_count INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Read-only mode after a downgrade with excess usage: the tenant keeps all
-- data but cannot create new metered resources (C-01).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS read_only BOOLEAN NOT NULL DEFAULT FALSE;
