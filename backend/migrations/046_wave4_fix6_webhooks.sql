-- Wave-4 Pass #6 (F1-L-2): idempotent coupon redemption on the webhook event id.
--
-- The E4-M-2 fix reprocesses crashed webhook events (ledger row exists in
-- stripe_webhook_events but processed_at IS NULL). The coupon redeem in
-- checkout.session.completed is the one non-idempotent handler path (the
-- subscription upsert is ON CONFLICT-idempotent), so a crash between the
-- redeem UPDATE and markProcessed double-counted redeemed_count and
-- double-released the reserved slot. Each redemption is now recorded
-- against the webhook event id; a reprocessed event skips the increment
-- when its event id is already recorded. The guard INSERT is atomic
-- (ON CONFLICT DO NOTHING), so crash-retries and concurrent duplicate
-- deliveries race safely: exactly one attempt performs the increment.
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  event_id TEXT PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  coupon_code TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
