-- 045: D1-M-2 (soft-deleted domain re-add) + D5-L-3 (global provider guard).
--
-- D1-M-2: the UNIQUE (tenant_id, domain) constraint blocked re-adding a
-- soft-deleted domain forever (ON CONFLICT DO NOTHING -> 409 SITE_EXISTS,
-- and no way to discover the deleted site's id for /restore). Replace it
-- with a PARTIAL unique index over live rows only, so a deleted domain can
-- be re-added (the route restores the soft-deleted row instead of 409).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sites_tenant_id_domain_key'
  ) THEN
    ALTER TABLE sites DROP CONSTRAINT sites_tenant_id_domain_key;
  END IF;
END $$;

DROP INDEX IF EXISTS sites_tenant_id_domain_active;
CREATE UNIQUE INDEX sites_tenant_id_domain_active
  ON sites (tenant_id, domain)
  WHERE deleted_at IS NULL;

-- D5-L-3: one guard row per UTC day, used by reserveGlobalProviderBudget to
-- serialize the global daily provider-spend check-and-reserve (SELECT FOR
-- UPDATE on this row makes the check atomic across tenants/processes).
CREATE TABLE IF NOT EXISTS global_provider_guard (
  day DATE PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
