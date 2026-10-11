-- Wave-4 Pass #1 backend fixes.
--
-- (A1-H1) Audit double-submit / enqueue-failure orphan race: two concurrent
-- POST /sites/:id/audits could both pass the route's SELECT check and INSERT
-- a 'queued' audit row; BullMQ's jobId dedupe meant only one row was ever
-- processed, leaving the other row 'queued' forever and 409-ing every future
-- audit for that site (same when enqueue() threw after the INSERT).
--
-- B2-M1: the orphan-cleanup UPDATE MUST run BEFORE the CREATE UNIQUE INDEX
-- below. On any database that still holds pre-A1-H1 duplicate 'queued'
-- orphans, creating the index first fails with a duplicate-key error and the
-- whole (transactional) migration rolls back — the cleanup this migration
-- exists for never runs. Fresh databases are unaffected either way.
--
-- NOTE (pre-production edit, sanctioned 2026-10-11): 041 had already been
-- applied to local dev DBs only; this product has NO production database yet,
-- so editing 041 in place is safe. Proven by resetting a scratch DB and
-- fresh-applying all migrations (see commit message).

-- Defense-in-depth cleanup for orphan rows the old code may already have
-- left behind: a 'queued' audit older than 2h was never picked up by the
-- worker (jobs start within seconds of enqueue), so mark it failed rather
-- than let it block the index below or all future audits for the site.
-- ('running' rows are left alone — the worker owns their lifecycle.)
UPDATE audits
SET status = 'failed', finished_at = now(),
    error = 'stale queued audit (pre-A1-H1-fix orphan)'
WHERE status = 'queued' AND started_at < now() - interval '2 hours';

-- The partial unique index makes the INSERT the atomic arbiter — the
-- concurrent loser gets 23505, which the route translates into the 409
-- AUDIT_RUNNING response instead of an orphan row.
CREATE UNIQUE INDEX IF NOT EXISTS audits_one_active_per_site
  ON audits (site_id) WHERE status IN ('queued', 'running');

-- (A2-L2) Drop duplicate indexes (write amplification on hot tables):
-- idx_w3_usage_tenant_type_time duplicates the (tenant_id, event_type,
-- created_at) index created by 001_init.sql — every recordUsage INSERT paid
-- the double write.
DROP INDEX IF EXISTS idx_w3_usage_tenant_type_time;
-- api_keys_hash_idx duplicates the btree backing the UNIQUE constraint on
-- api_keys.key_hash (017_api_keys.sql).
DROP INDEX IF EXISTS api_keys_hash_idx;
