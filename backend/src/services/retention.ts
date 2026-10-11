import { query as defaultQuery, type QueryFn } from '../db.js';

// ---------------------------------------------------------------------------
// C-06: retention policy + cleanup jobs.
// Policies live in the retention_policies table (013); this job deletes rows
// older than keep_for. Tables that do not exist (yet) are skipped so policy
// rows can be seeded ahead of the migrations that create them.
// ---------------------------------------------------------------------------

interface EntityRule {
  table: string;
  dateColumn: string;
  extraWhere?: string;
}

const ENTITY_RULES: Record<string, EntityRule> = {
  usage_events: { table: 'usage_events', dateColumn: 'created_at' },
  // audit_issues cascades from audits (ON DELETE CASCADE) — no standalone rule.
  audits: { table: 'audits', dateColumn: 'finished_at' }, // NULL (unfinished) is never swept
  rank_checks: { table: 'rank_checks', dateColumn: 'checked_at' },
  geo_checks: { table: 'geo_checks', dateColumn: 'checked_at' },
  provider_spend: { table: 'provider_spend', dateColumn: 'created_at' },
  webhook_deliveries: {
    table: 'webhook_deliveries',
    dateColumn: 'created_at',
    // Never delete a pending delivery that still has retries scheduled.
    extraWhere: `NOT (status = 'pending' AND next_retry_at > now())`,
  },
  dead_letter_jobs: {
    table: 'dead_letter_jobs',
    dateColumn: 'failed_at',
    extraWhere: `status <> 'pending'`,
  },
  notification_log: { table: 'notification_log', dateColumn: 'created_at' },
  activity_log: { table: 'activity_log', dateColumn: 'created_at' },
  api_request_log: { table: 'api_request_log', dateColumn: 'created_at' },
  usage_reservations: {
    table: 'usage_reservations',
    dateColumn: 'created_at',
    // Committed reservations ARE the usage record — keep them like
    // usage_events. Only dead holds (cancelled / long-expired) are purged.
    extraWhere: `status = 'cancelled' OR (status = 'reserved' AND expires_at < now() - interval '7 days')`,
  },
};

export interface CleanupResult {
  entity: string;
  deleted: number;
}

/**
 * Built-in retention windows, mirroring the migration 013 seed. Used when
 * the retention_policies table is empty (e.g. wiped by a test TRUNCATE or
 * an ops accident) so cleanup degrades to defaults instead of silently
 * doing nothing.
 */
export const DEFAULT_RETENTION_POLICIES: Record<string, string> = {
  usage_events: '13 months',
  audits: '12 months',
  rank_checks: '13 months',
  geo_checks: '12 months',
  provider_spend: '13 months',
  webhook_deliveries: '90 days',
  dead_letter_jobs: '90 days',
  notification_log: '12 months',
  activity_log: '24 months',
  api_request_log: '30 days',
  usage_reservations: '3 months',
};

/**
 * Runs the retention cleanup once. Returns per-entity delete counts.
 * Safe to run concurrently (each DELETE is a single statement).
 */
export async function runRetentionCleanup(q: QueryFn = defaultQuery): Promise<CleanupResult[]> {
  // DB rows override the built-in defaults per entity; entities missing from
  // the table (new rules, wiped seeds) still get their default window.
  const policies = await q(`SELECT entity, keep_for FROM retention_policies`);
  const keepByEntity: Record<string, string> = { ...DEFAULT_RETENTION_POLICIES };
  for (const p of policies.rows) keepByEntity[p.entity as string] = p.keep_for as string;
  const entries = Object.entries(keepByEntity).map(([entity, keep_for]) => ({ entity, keep_for }));
  const results: CleanupResult[] = [];
  for (const p of entries) {
    const entity = p.entity as string;
    const rule = ENTITY_RULES[entity];
    if (!rule) continue;
    // Skip tables (or age columns) that do not exist — policy may be seeded
    // ahead of the migration that creates them.
    const exists = await q(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [rule.table, rule.dateColumn],
    );
    if (exists.rows.length === 0) continue;
    const where = [
      `${rule.dateColumn} < now() - $1::interval`,
      ...(rule.extraWhere ? [rule.extraWhere] : []),
    ].join(' AND ');
    const del = await q(`DELETE FROM ${rule.table} WHERE ${where}`, [p.keep_for as string]);
    results.push({ entity, deleted: del.rowCount ?? 0 });
  }
  // Soft-deleted sites: hard-purge after the 30-day restore window (C-06).
  const purge = await q(`DELETE FROM sites WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days'`);
  results.push({ entity: 'sites.soft_deleted', deleted: purge.rowCount ?? 0 });
  // NEW-3: stale PENDING idempotency claims (owner crashed mid-request)
  // are abandoned after 5 minutes — the middleware also takes them over
  // lazily on the next same-key request; this sweep reaps the ones
  // nobody retries. Completed claims (status_code NOT NULL) are replay
  // evidence and are NOT touched here.
  const idemExists = await q(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'idempotency_keys' AND column_name = 'created_at'`,
  );
  if (idemExists.rows.length > 0) {
    const stale = await q(
      `DELETE FROM idempotency_keys
       WHERE status_code IS NULL AND created_at < now() - interval '5 minutes'`,
    );
    results.push({ entity: 'idempotency_keys.stale_pending', deleted: stale.rowCount ?? 0 });
  }
  return results;
}

/**
 * Soft-deletes a site (C-06). The site disappears from listings immediately
 * but is restorable for 30 days; the retention job hard-purges afterwards.
 */
export async function softDeleteSite(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<boolean> {
  const r = await q(
    `UPDATE sites SET deleted_at = now()
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [siteId, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Restores a soft-deleted site within the 30-day window. */
export async function restoreSite(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<boolean> {
  const r = await q(
    `UPDATE sites SET deleted_at = NULL
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NOT NULL
       AND deleted_at > now() - interval '30 days'`,
    [siteId, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}
