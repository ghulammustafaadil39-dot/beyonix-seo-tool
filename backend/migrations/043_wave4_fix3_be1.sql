-- Wave-4 Pass #3 (BE-1): coupon reservation accounting (C5-H-1 / C1-M-6).
-- checkouts atomically reserve a redemption slot (reserved_count) under a
-- row lock BEFORE the Stripe discount is attached, so concurrent checkouts
-- can no longer overshoot max_redemptions. Slots are released on
-- checkout.session.expired and converted to redeemed_count on
-- checkout.session.completed.
ALTER TABLE billing_coupons ADD COLUMN IF NOT EXISTS reserved_count INT NOT NULL DEFAULT 0;
