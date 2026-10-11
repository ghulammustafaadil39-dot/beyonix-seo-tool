-- S-08: domain verification hardening.
-- One domain may be VERIFIED by only one tenant at a time (partial unique
-- index). verified_at / last_reverified_at support the weekly re-verify job.

ALTER TABLE sites ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS last_reverified_at TIMESTAMPTZ;

-- Backfill: previously verified sites count as verified at creation time.
UPDATE sites SET verified_at = COALESCE(verified_at, created_at) WHERE verified = true;

-- Defensive dedupe: if the same domain is somehow verified by two tenants
-- (possible before this index existed), keep the earliest and unverify the rest.
UPDATE sites SET verified = false, verified_at = NULL
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY domain ORDER BY created_at ASC, id ASC) AS rn
    FROM sites
    WHERE verified = true
  ) dups
  WHERE rn > 1
);

-- One-domain-one-tenant: enforced only for verified rows, so tenants can
-- still each hold an UNVERIFIED draft of the same domain.
CREATE UNIQUE INDEX IF NOT EXISTS sites_verified_domain_uidx
  ON sites (domain) WHERE verified = true;
