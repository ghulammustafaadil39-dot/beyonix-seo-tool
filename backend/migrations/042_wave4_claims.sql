-- Wave-4 Pass #1 (A2-M4): atomic claim column for webhook-delivery retries.
-- processWebhookRetries claims each delivery with a conditional UPDATE
-- (status pending -> in_progress) so two scheduler processes can never
-- deliver the same webhook twice. claimed_at lets a later tick reclaim a
-- delivery whose worker died mid-flight (stale 'in_progress' rows).
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- Wave-4 Pass #1 (A2-L5): maps a local billing_coupons row to the real
-- Stripe coupon id. Local codes (e.g. LAUNCH20) must never be passed to
-- Stripe as coupon IDs — the id is resolved at checkout and stored here.
ALTER TABLE billing_coupons ADD COLUMN IF NOT EXISTS stripe_coupon_id TEXT;

-- Wave-4 Pass #1 (A2-L6): committed usage reservations age out on the
-- 13-month billing-evidence window, same as usage_events.
INSERT INTO retention_policies (entity, keep_for, description) VALUES
  ('usage_reservations_committed', interval '13 months', 'Committed usage reservations (usage evidence)')
ON CONFLICT (entity) DO NOTHING;
