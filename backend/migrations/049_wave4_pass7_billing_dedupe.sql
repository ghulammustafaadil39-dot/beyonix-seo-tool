-- Wave-4 Pass#7 fix (G1-L-1): dedupe customer lifecycle emails on
-- (webhook event_id, billing event type).
--
-- The E4-M-2 crash-retry / F2-L-1 concurrent-duplicate reprocess path
-- re-runs whole webhook handlers. Money effects are event-id-guarded
-- (coupon_redemptions, tenant_credits.webhook_event_id), but the dunning /
-- lifecycle emails in registerDefaultBillingHooks were not — a reprocessed
-- event sent the same email twice. The default hook now checks for an
-- existing 'sent' row for (event_id, notification_type) before sending and
-- records the event id on the row it writes, so a reprocess skips.
--
-- Partial unique index: NULL event ids (direct callers, pre-migration
-- rows) never conflict, so legacy inserts are unaffected.
ALTER TABLE notification_log
  ADD COLUMN IF NOT EXISTS event_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS notification_log_event_dedupe_idx
  ON notification_log (event_id, notification_type)
  WHERE event_id IS NOT NULL;
