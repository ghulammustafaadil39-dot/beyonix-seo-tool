import { query as defaultQuery, type QueryFn } from '../db.js';

/**
 * Agency/team activity log (F-09). Every membership, workspace, invitation,
 * API-key and admin-facing change writes here — the tenant's audit trail.
 */
export async function logActivity(
  tenantId: string,
  entry: {
    userId?: string | null;
    workspaceId?: string | null;
    action: string;
    entityType?: string;
    entityId?: string;
    meta?: Record<string, unknown>;
  },
  q: QueryFn = defaultQuery,
): Promise<void> {
  await q(
    `INSERT INTO activity_log (id, tenant_id, user_id, workspace_id, action, entity_type, entity_id, meta)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
    [
      tenantId,
      entry.userId ?? null,
      entry.workspaceId ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.meta ? JSON.stringify(entry.meta) : null,
    ],
  );
}
