-- Wave-4 Pass #4 (BE-A): server-side 14-day trial (D5-H-1).
-- New signups get a server-side trial with Starter quota; after the trial
-- expires with no active subscription, the subscription gate
-- (middleware/requireSubscription.ts) 402s spend routes and flips the
-- tenant read-only via the existing machinery.
--
-- tenants.trial_ends_at: NULL means "grandfathered" (pre-trial tenant —
-- seed/demo/existing rows are backfilled far-future AND the middleware
-- treats NULL as grandfathered, belt and braces). New rows default to
-- now() + 14 days (the authoritative length is signupTrialDays() in
-- services/billing.ts, applied explicitly at signup in routes/auth.ts;
-- the column default is a backstop for any other insert path).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

-- Backfill: every tenant that predates the trial feature is grandfathered
-- and must never be locked out by the new gate.
UPDATE tenants
SET trial_ends_at = now() + interval '100 years'
WHERE trial_ends_at IS NULL;

ALTER TABLE tenants ALTER COLUMN trial_ends_at SET DEFAULT (now() + interval '14 days');
ALTER TABLE tenants ALTER COLUMN trial_ends_at SET NOT NULL;
