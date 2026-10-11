-- Wave-4 Pass#6 fix rework (LA): F2-L-1.
--
-- Reverts 047's started_at lease. The lease created a worse hole than the
-- one it closed: a genuinely crashed webhook attempt redelivered by Stripe
-- inside the 5-minute lease window was swallowed as a "concurrent
-- duplicate", breaking the E4-M-2 crash-recovery it was meant to protect
-- (proven by the w4-fix6-webhooks F1-L-2 regression test failing on main).
-- Concurrent-duplicate safety is achieved per-handler via event-id
-- idempotency guards instead (coupon_redemptions for coupons, and below
-- for refund credits), which compose correctly with crash recovery.
ALTER TABLE stripe_webhook_events DROP COLUMN IF EXISTS started_at;

-- Idempotency guard for the charge.refunded -> tenant_credits path: a
-- reprocessed (E4-M-2 crash retry) or concurrently-duplicate-delivered
-- refund must not credit the tenant twice. Plain UNIQUE: multiple NULLs
-- (mock path without an event id) never conflict, preserving old behavior.
ALTER TABLE tenant_credits ADD COLUMN IF NOT EXISTS webhook_event_id TEXT UNIQUE;
