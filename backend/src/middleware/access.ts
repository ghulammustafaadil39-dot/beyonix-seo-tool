import type { FastifyRequest } from 'fastify';
import { ApiError, forbidden } from '../errors.js';
import { query } from '../db.js';

// ---------------------------------------------------------------------------
// F-09: team roles. Hierarchy: owner > admin > editor > viewer.
// ---------------------------------------------------------------------------

const ROLE_RANK: Record<string, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

/**
 * preHandler factory: allows the listed roles (or any HIGHER role).
 * API-key contexts pass only with the 'admin' scope (keys authenticate as
 * the tenant; fine-grained access is otherwise gated by requireScope).
 */
export function requireRole(...allowed: string[]) {
  const minRank = Math.min(...allowed.map((r) => ROLE_RANK[r] ?? 99));
  return async (req: FastifyRequest) => {
    const t = (req as any).tenant;
    if (!t) throw forbidden();
    if (t.apiKeyId) {
      if ((t.apiKeyScopes ?? []).includes('admin')) return;
      throw forbidden('This action requires a team session with a sufficient role');
    }
    const rank = ROLE_RANK[t.role as string] ?? 0;
    if (rank < minRank) {
      throw forbidden(`Requires role: ${allowed.join(' or ')}`);
    }
  };
}

/** True when the caller's role outranks (or equals) the target role. */
export function canAssignRole(actorRole: string, targetRole: string): boolean {
  if (targetRole === 'owner') return false; // ownership transfers separately
  return (ROLE_RANK[actorRole] ?? 0) > (ROLE_RANK[targetRole] ?? 0);
}

// ---------------------------------------------------------------------------
// F-13: API key scopes.
// ---------------------------------------------------------------------------

/** Catalog of public-API scopes (shown in docs + the keys UI). */
export const API_SCOPES = [
  'sites:read',
  'sites:write',
  'audits:read',
  'audits:write',
  'keywords:read',
  'keywords:write',
  'ranks:read',
  'content:read',
  'content:write',
  'geo:read',
  'backlinks:read',
  'reports:read',
  'reports:write',
  'billing:read',
  'webhooks:read',
  'webhooks:write',
  'admin',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(s: string): s is ApiScope {
  return (API_SCOPES as readonly string[]).includes(s);
}

/**
 * preHandler factory: session users pass freely; API-key callers must hold
 * the scope (or the 'admin' scope, which implies all).
 */
export function requireScope(...scopes: ApiScope[]) {
  return async (req: FastifyRequest) => {
    const t = (req as any).tenant;
    if (!t?.apiKeyId) return; // user session: roles gate elsewhere
    const held: string[] = t.apiKeyScopes ?? [];
    const missing = scopes.filter((s) => !scopeSatisfied(held, s));
    if (missing.length > 0) {
      throw new ApiError(403, 'INSUFFICIENT_SCOPE', `API key lacks required scope(s): ${missing.join(', ')}`, {
        missing,
      });
    }
  };
}

/** True when the held scopes satisfy a requirement ('admin' and ':write' imply ':read'). */
function scopeSatisfied(held: string[], need: string): boolean {
  if (held.includes('admin') || held.includes(need)) return true;
  if (need.endsWith(':read')) return held.includes(`${need.slice(0, -5)}:write`);
  return false;
}

/** The acting user for audit/UUID columns: null when the caller is an API key
 * (API keys carry no user; attribution goes in meta.apiKeyId instead). */
export function actorUserId(req: FastifyRequest): string | null {
  const t = (req as any).tenant;
  return t?.apiKeyId ? null : ((t?.userId as string | null) ?? null);
}

/** Attribution meta for activity logs when the actor is an API key. */
export function actorMeta(req: FastifyRequest): Record<string, unknown> {
  const t = (req as any).tenant;
  return t?.apiKeyId ? { apiKeyId: t.apiKeyId } : {};
}

/**
 * Dual gate for routes shared by team sessions and API keys: team sessions
 * are authorized by role, API keys by scope. Replaces stacking requireRole +
 * requireScope (which rejected scoped keys at the role layer).
 */
export function requireRoleOrScope(roles: string[], ...scopes: ApiScope[]) {
  return async (req: FastifyRequest) => {
    const t = (req as any).tenant;
    if (!t) throw forbidden();
    if (t.apiKeyId) {
      const held: string[] = t.apiKeyScopes ?? [];
      const missing = scopes.filter((s) => !scopeSatisfied(held, s));
      if (missing.length > 0) {
        throw new ApiError(403, 'INSUFFICIENT_SCOPE', `API key lacks required scope(s): ${missing.join(', ')}`, {
          missing,
        });
      }
      return;
    }
    const minRank = Math.min(...roles.map((r) => ROLE_RANK[r] ?? 99));
    const rank = ROLE_RANK[t.role as string] ?? 0;
    if (rank < minRank) throw forbidden(`Requires role: ${roles.join(' | ')}`);
  };
}

// ---------------------------------------------------------------------------
// F-14: platform admin.
// ---------------------------------------------------------------------------

/**
 * preHandler: platform admins only (users.is_platform_admin). Every admin
 * action must also write to admin_audit_log — use logAdminAction().
 */
export async function requirePlatformAdmin(req: FastifyRequest): Promise<void> {
  const t = (req as any).tenant;
  if (!t?.isPlatformAdmin) {
    // 404 (not 403): the back-office must not be discoverable (frozen
    // contract §3.3 — no existence leak).
    throw new ApiError(404, 'NOT_FOUND', 'Not found');
  }
}

export async function logAdminAction(
  req: FastifyRequest,
  action: string,
  targetTenantId?: string | null,
  meta?: Record<string, unknown>,
): Promise<void> {
  const t = (req as any).tenant;
  await query(
    `INSERT INTO admin_audit_log (id, actor_user_id, actor_tenant_id, action, target_tenant_id, meta)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [
      t?.apiKeyId ? null : (t?.userId ?? null),
      t?.tenantId ?? null,
      action,
      targetTenantId ?? null,
      meta ? JSON.stringify(meta) : null,
    ],
  );
}
