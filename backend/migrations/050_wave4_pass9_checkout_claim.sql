-- I1-L-3 (pass#9): in-flight checkout session claim. Two overlapping
-- POST /billing/checkout calls used to both pass the ALREADY_SUBSCRIBED
-- check (neither had a subscription row yet) and create two Stripe
-- sessions; completing both left two live Stripe subscriptions while the
-- E4-H-2 supersede guard warn-and-ignored the second one's events (tenant
-- billed twice, entitled once). One claim row per tenant: 'creating' while
-- the Stripe API call is in flight, 'open' once the session URL exists.
-- Cleared by checkout.session.completed / checkout.session.expired
-- webhooks and by the route's failure path; a stale 'creating' claim
-- (>10 min — the creator crashed) is stolen by the next checkout attempt.
CREATE TABLE IF NOT EXISTS checkout_sessions (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_session_id TEXT,
  checkout_url TEXT,
  plan_id TEXT NOT NULL,
  billing_interval TEXT NOT NULL DEFAULT 'monthly',
  status TEXT NOT NULL DEFAULT 'creating' CHECK (status IN ('creating', 'open')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
