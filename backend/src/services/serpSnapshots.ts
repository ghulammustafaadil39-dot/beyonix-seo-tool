// Shared cross-tenant SERP snapshot cache (C-05).
//
// - One provider call per (keyword, location, device, language) — never per
//   tenant. Two tenants tracking the same keyword/location share the snapshot
//   row; only the tenant that caused the fetch is metered (cost accounting
//   on miss). Cache hits are free for everyone.
// - Thundering-herd protection: a short Redis lock coalesces concurrent
//   misses; losers wait briefly then read the winner's row.
// - 7-day TTL. "Not in top 100" = own domain absent from the 100 items.

import { getKeywordSerpProvider } from '../providers/dataforseo.js';
import { assertDataBudget, recordUsage } from '../metering.js';
import type { SerpItem, SerpSnapshotResult, KeywordSerpProvider } from '../providers/types.js';
import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';
import { getRedis, redisKeyPrefix } from '../redis.js';

export const SNAPSHOT_TTL_DAYS = 7;

export interface SnapshotOpts {
  locationCode?: number;
  device?: string;
  language?: string;
}

export interface SnapshotResult {
  snapshotId: string;
  items: SerpItem[];
  features: string[];
  /** own position in the snapshot, null when not in top 100 */
  position: number | null;
  url: string | null;
  /** rank_absolute of the own-domain item (pixel-rank approximation) */
  pixelRank: number | null;
  notRanked: boolean;
  cached: boolean;
  providerIsMock: boolean;
}

export function snapshotCacheKey(keyword: string, locationCode: number, device: string, language: string): string {
  return `${keyword.trim().toLowerCase()}|${locationCode}|${device}|${language}`;
}

function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^www\./, '');
}

/** Pure: locate the tenant's domain inside snapshot items. */
export function findOwnPosition(items: SerpItem[], domain: string): { position: number | null; url: string | null } {
  const want = normalizeDomain(domain);
  for (const it of items) {
    if (normalizeDomain(it.domain) === want) {
      return { position: it.position, url: it.url };
    }
  }
  return { position: null, url: null };
}

/** Best-effort Redis in-flight lock. Null when Redis is unavailable. */
async function tryAcquireFlightLock(key: string, ttlSec = 60): Promise<boolean> {
  try {
    const res = await getRedis().set(`${redisKeyPrefix()}serpflight:${key}`, '1', 'EX', ttlSec, 'NX');
    return res === 'OK';
  } catch {
    return true; // degrade: no coalescing, but never block the check
  }
}

async function releaseFlightLock(key: string): Promise<void> {
  try {
    await getRedis().del(`${redisKeyPrefix()}serpflight:${key}`);
  } catch {
    /* ignore */
  }
}

async function readFreshSnapshot(
  q: QueryFn,
  cacheKey: string,
): Promise<{ id: string; items: SerpItem[]; features: string[] } | null> {
  const r = await q(
    `SELECT id, items, features FROM serp_snapshots
     WHERE cache_key = $1 AND fetched_at > now() - ($2 || ' days')::interval`,
    [cacheKey, String(SNAPSHOT_TTL_DAYS)],
  );
  if (r.rows.length === 0) return null;
  return {
    id: r.rows[0].id as string,
    items: (r.rows[0].items ?? []) as SerpItem[],
    features: (r.rows[0].features ?? []) as string[],
  };
}

async function fetchFreshSnapshot(
  keyword: string,
  domain: string,
  locationCode: number,
  device: string,
  provider: KeywordSerpProvider,
): Promise<SerpSnapshotResult> {
  if (provider.serpFull) {
    return provider.serpFull(keyword, domain, locationCode, device);
  }
  // Fallback for providers without serpFull: synthesize a 1-item snapshot.
  const s = await provider.serp(keyword, domain, locationCode);
  const items: SerpItem[] = s.position
    ? [{ position: s.position, url: s.url ?? '', domain, title: null, itemType: 'organic' }]
    : [];
  return { items, features: s.features };
}

/**
 * Cached full-SERP snapshot. Metered (serp_check) only on cache miss, and
 * only for the tenant that caused the fetch.
 */
export async function getSerpSnapshot(
  tenantId: string,
  keyword: string,
  domain: string,
  opts: SnapshotOpts = {},
  q: QueryFn = defaultQuery,
  providerOverride?: KeywordSerpProvider,
): Promise<SnapshotResult> {
  const locationCode = opts.locationCode ?? 2840;
  const device = opts.device ?? 'desktop';
  const language = opts.language ?? 'en';
  const key = snapshotCacheKey(keyword, locationCode, device, language);

  const fresh = await readFreshSnapshot(q, key);
  if (fresh) {
    const own = findOwnPosition(fresh.items, domain);
    return {
      snapshotId: fresh.id,
      items: fresh.items,
      features: fresh.features,
      position: own.position,
      url: own.url,
      pixelRank: own.position,
      notRanked: own.position === null,
      cached: true,
      providerIsMock: false,
    };
  }

  // Miss: coalesce concurrent fetches for the same key.
  const won = await tryAcquireFlightLock(key);
  if (!won) {
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const retry = await readFreshSnapshot(q, key);
      if (retry) {
        const own = findOwnPosition(retry.items, domain);
        return {
          snapshotId: retry.id,
          items: retry.items,
          features: retry.features,
          position: own.position,
          url: own.url,
          pixelRank: own.position,
          notRanked: own.position === null,
          cached: true,
          providerIsMock: false,
        };
      }
    }
    // Winner died or is very slow — proceed to fetch ourselves.
  }

  try {
    await assertDataBudget(tenantId, 'serp_checks', 1, q);
    const provider = providerOverride ?? getKeywordSerpProvider();
    const snap = await fetchFreshSnapshot(keyword, domain, locationCode, device, provider);
    const ins = await q(
      `INSERT INTO serp_snapshots (id, cache_key, keyword, location_code, device, language, fetched_at, items, features)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now(), $6, $7)
       ON CONFLICT (cache_key) DO UPDATE SET
         fetched_at = now(), items = EXCLUDED.items, features = EXCLUDED.features
       RETURNING id`,
      [key, keyword.trim().toLowerCase(), locationCode, device, language, JSON.stringify(snap.items), JSON.stringify(snap.features)],
    );
    await recordUsage(tenantId, 'serp_check', 1, undefined, { cache: 'miss', shared: true, snapshot: true }, q);
    const own = findOwnPosition(snap.items, domain);
    return {
      snapshotId: ins.rows[0].id as string,
      items: snap.items,
      features: snap.features,
      position: own.position,
      url: own.url,
      pixelRank: own.position,
      notRanked: own.position === null,
      cached: false,
      providerIsMock: provider.isMock,
    };
  } finally {
    if (won) await releaseFlightLock(key);
  }
}
