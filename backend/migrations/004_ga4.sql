-- GA4 property linkage for traffic overview (ARCHITECTURE.md §12 item 2).
-- The Google OAuth refresh token is shared with GSC (analytics.readonly scope
-- is already requested in the consent screen), so only the property id is new.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS ga4_property_id TEXT NULL;
