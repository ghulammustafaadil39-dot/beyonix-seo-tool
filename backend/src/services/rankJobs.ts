// Rank-check job processor — Phase 7: free tracking via DuckDuckGo HTML.
//
// - Per-keyword tracking config: device / location_code / language
//   (rank_tracking_configs; defaults: site location, desktop, en).
// - Free SERP snapshots (top 10 via DDG, no paid APIs, no DataForSEO
//   budget). "Not in top 10" = position NULL.
// - Position-change alerts (drops > 5 positions, gains >= 6, in/out of the
//   top 10): persisted to rank_alerts with a beginner-friendly `reason`,
//   emitted to alert_events (F-10 rules hook), and sent via the tenant's
//   notify channels.

import type { Job } from 'bullmq';
import { query as defaultQuery } from '../db.js';
import type { SnapshotOpts } from './serpSnapshots.js';
import { checkRanks } from './rankChecker.js';

export interface TrackingConfig extends SnapshotOpts {
  locationCode: number;
  device: string;
  language: string;
}

export const DEFAULT_TRACKING: TrackingConfig = { locationCode: 2840, device: 'desktop', language: 'en' };

/** Pure: merge a stored config row with defaults. */
export function resolveTrackingConfig(
  row: { device?: string | null; location_code?: number | null; language?: string | null } | null,
  siteLocationCode: number,
): TrackingConfig {
  return {
    device: row?.device || 'desktop',
    locationCode: Number.isInteger(row?.location_code) && (row?.location_code as number) > 0
      ? (row?.location_code as number)
      : siteLocationCode,
    language: row?.language || 'en',
  };
}

export async function rankCheckProcessor(job: Job): Promise<unknown> {
  const { siteId, tenantId } = (job.data ?? {}) as { siteId: string; tenantId: string };
  // Phase 7: free rank tracking via DuckDuckGo HTML (no paid SERP APIs,
  // no DataForSEO budget). checkRanks writes rank_checks + serp_snapshots
  // + rank_alerts (with beginner-friendly reasons), emits alert_events,
  // and notifies the tenant — the same tables the ranks routes read.
  const { checked, alerts } = await checkRanks(tenantId, siteId, defaultQuery);
  return { checked, alerts: alerts.map(({ keywordId, ...rest }) => rest) };
}
