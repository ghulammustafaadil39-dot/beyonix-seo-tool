import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';

// W-02: anomaly detection on rank movements.
// Method (honest, simple): take the keyword's daily position DELTAS over the
// rolling history; the latest delta is anomalous when |delta| >= 10 (hard
// threshold, the pre-existing alert rule) OR its z-score vs the rolling
// deltas is >= 2 with at least 5 historical deltas to judge against.

export interface AnomalyResult {
  anomaly: boolean;
  zScore: number | null;
  reason: string | null;
  delta: number | null;
}

export function detectRankAnomaly(positionsNewestFirst: Array<number | null>): AnomalyResult {
  const pts = positionsNewestFirst.filter((p): p is number => p !== null);
  if (pts.length < 2) return { anomaly: false, zScore: null, reason: null, delta: null };
  const deltas: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) deltas.push(pts[i] - pts[i + 1]); // + = improved
  const latest = deltas[0];
  if (Math.abs(latest) >= 10) {
    return { anomaly: true, zScore: null, reason: `position moved ${latest} places in one check (|delta| >= 10)`, delta: latest };
  }
  const history = deltas.slice(1);
  if (history.length >= 5) {
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const variance = history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length;
    const sd = Math.sqrt(variance);
    if (sd > 0) {
      const z = (latest - mean) / sd;
      if (Math.abs(z) >= 2) {
        return { anomaly: true, zScore: Number(z.toFixed(2)), reason: `delta z-score ${z.toFixed(2)} vs rolling history`, delta: latest };
      }
      return { anomaly: false, zScore: Number(z.toFixed(2)), reason: null, delta: latest };
    }
  }
  return { anomaly: false, zScore: null, reason: null, delta: latest };
}

/**
 * Scans one keyword's recent rank_checks; when the latest movement is
 * anomalous, persists a rank_alerts row (anomaly=TRUE) — deduplicated to one
 * anomaly alert per keyword per UTC day. Returns the detection result.
 */
export async function scanKeywordAnomaly(
  tenantId: string,
  siteId: string,
  keywordId: string,
  q: QueryFn = defaultQuery,
): Promise<AnomalyResult> {
  const r = await q(
    `SELECT position FROM rank_checks WHERE tenant_id = $1 AND keyword_id = $2 ORDER BY checked_at DESC LIMIT 30`,
    [tenantId, keywordId],
  );
  const positions = r.rows.map((x: any) => x.position as number | null);
  const result = detectRankAnomaly(positions);
  if (!result.anomaly) return result;
  const existing = await q(
    `SELECT id FROM rank_alerts WHERE tenant_id = $1 AND keyword_id = $2 AND anomaly = TRUE AND created_at >= date_trunc('day', now()) LIMIT 1`,
    [tenantId, keywordId],
  );
  if (existing.rows.length === 0) {
    const latest = positions[0] ?? null;
    const prev = positions[1] ?? null;
    await q(
      `INSERT INTO rank_alerts (id, tenant_id, keyword_id, site_id, direction, prev_position, position, delta, anomaly, z_score, anomaly_reason)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9)`,
      [tenantId, keywordId, siteId, (result.delta ?? 0) >= 0 ? 'improved' : 'dropped', prev, latest, result.delta ?? 0, result.zScore, result.reason],
    );
  }
  return result;
}
