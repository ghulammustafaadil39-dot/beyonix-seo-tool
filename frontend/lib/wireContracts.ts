// Typed mirrors of the REAL backend wire shapes — keep in sync with:
//   backend/src/services/jobStream.ts  (JobsSnapshot)
//   backend/src/routes/jobEvents.ts     (snapshot / done / error events)
//   backend/src/services/insights.ts    (InsightAction, Forecast)
//   backend/src/routes/insights.ts      (envelope)
// These fixtures feed the normalizers below at the TYPE level (checked by
// `npx tsc --noEmit`); scripts/contract-smoke.mjs executes the same shapes
// at runtime against the compiled normalizers.

import {
  normalizeForecast,
  normalizeInsightList,
  resolveInsightHref,
} from './api';
import { normalizeJobProgress, type JobProgress } from './useJobStream';

// --- wire shapes (mirrors) -------------------------------------------------

export interface AuditSnapshotWire {
  id: string;
  status: string;
  score: number | null;
  pagesCrawled: number;
  issuesCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  progressPct: number | null;
}

export interface ReportSnapshotWire {
  id: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
}

export interface JobsSnapshotWire {
  audits: AuditSnapshotWire[];
  reports: ReportSnapshotWire[];
  rankRun: { checksLast24h: number; latestCheckedAt: string | null; informational: true };
  settled: boolean;
}

export interface StreamDoneWire {
  settled: boolean;
  at: string;
}

export interface StreamErrorWire {
  message: string;
}

export type InsightActionTypeWire =
  | 'critical_audit_issue'
  | 'rank_drop'
  | 'content_gap'
  | 'unranked_keyword';

export interface InsightActionWire {
  type: InsightActionTypeWire;
  priority: number;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  target: { kind: string; id?: string; href: string };
  source: 'computed';
}

export interface ForecastWire {
  kind: 'projection';
  label: string;
  method: string;
  visibilityIndexNow: number;
  visibilityIndexProjected: number;
  horizonDays: number;
  basedOnDays: number;
}

export interface InsightsEnvelopeWire {
  engine: 'rules-v1';
  computedAt: string;
  actions: InsightActionWire[];
  forecast: ForecastWire;
}

// --- fixtures (copied from the backend emit code, not invented) ------------

const SITE = '123e4567-e89b-12d3-a456-426614174000';

export const SNAPSHOT_RUNNING: JobsSnapshotWire = {
  audits: [
    {
      id: 'audit-1',
      status: 'running',
      score: null,
      pagesCrawled: 41,
      issuesCount: 3,
      startedAt: '2026-10-11T10:00:00.000Z',
      finishedAt: null,
      progressPct: 50,
    },
  ],
  reports: [],
  rankRun: { checksLast24h: 12, latestCheckedAt: '2026-10-11T09:30:00.000Z', informational: true },
  settled: false,
};

export const SNAPSHOT_SETTLED_DONE: JobsSnapshotWire = {
  audits: [
    {
      id: 'audit-1',
      status: 'done',
      score: 87,
      pagesCrawled: 120,
      issuesCount: 5,
      startedAt: '2026-10-11T10:00:00.000Z',
      finishedAt: '2026-10-11T10:04:00.000Z',
      progressPct: 100,
    },
  ],
  reports: [{ id: 'rep-1', periodStart: '2026-09-01', periodEnd: '2026-09-30', createdAt: '2026-10-01T00:00:00.000Z' }],
  rankRun: { checksLast24h: 0, latestCheckedAt: null, informational: true },
  settled: true,
};

export const SNAPSHOT_EMPTY_SETTLED: JobsSnapshotWire = {
  audits: [],
  reports: [],
  rankRun: { checksLast24h: 0, latestCheckedAt: null, informational: true },
  settled: true,
};

export const SNAPSHOT_REPORTS: JobsSnapshotWire = {
  audits: [],
  reports: [
    { id: 'rep-2', periodStart: '2026-10-01', periodEnd: '2026-10-07', createdAt: '2026-10-08T00:00:00.000Z' },
    { id: 'rep-1', periodStart: '2026-09-01', periodEnd: '2026-09-30', createdAt: '2026-10-01T00:00:00.000Z' },
  ],
  rankRun: { checksLast24h: 0, latestCheckedAt: null, informational: true },
  settled: true,
};

export const DONE_WIRE: StreamDoneWire = { settled: true, at: '2026-10-11T10:05:00.000Z' };
export const ERROR_WIRE: StreamErrorWire = { message: 'internal error' };

export const INSIGHTS_ENVELOPE: InsightsEnvelopeWire = {
  engine: 'rules-v1',
  computedAt: '2026-10-11T10:05:00.000Z',
  actions: [
    {
      type: 'rank_drop',
      priority: 88,
      title: 'Investigate rank drop: "seo tool" 4 -> 12',
      detail: 'Diagnosis (computed from tracked data): no site-wide pattern detected.',
      evidence: { keyword: 'seo tool', from: 4, to: 12 },
      target: { kind: 'keyword', id: 'kw-1', href: `/dashboard/sites/${SITE}?tab=rankings` },
      source: 'computed',
    },
    {
      type: 'critical_audit_issue',
      priority: 95,
      title: 'Fix critical audit issue: missing_title (3 pages)',
      detail: '3 open error-severity issue(s) of type missing_title.',
      evidence: { issueType: 'missing_title', count: 3 },
      target: { kind: 'audit', href: `/dashboard/sites/${SITE}?tab=audit` },
      source: 'computed',
    },
  ],
  forecast: {
    kind: 'projection',
    label: 'Projection — linear trend on the rank-visibility index. NOT measured traffic and NOT a guarantee.',
    method: 'least-squares slope over daily average visibility, extrapolated 28 days, clamped to [0,100]',
    visibilityIndexNow: 42.5,
    visibilityIndexProjected: 47.8,
    horizonDays: 28,
    basedOnDays: 21,
  },
};

// --- type-level contract checks (must compile under tsc --noEmit) ---------

// Every real wire shape must be acceptable normalizer input, and the
// outputs must be the documented UI types.
const _t1: JobProgress | null = normalizeJobProgress(SNAPSHOT_RUNNING, { eventName: 'snapshot' });
const _t2: JobProgress | null = normalizeJobProgress(SNAPSHOT_SETTLED_DONE, { eventName: 'snapshot' });
const _t3: JobProgress | null = normalizeJobProgress(DONE_WIRE, { eventName: 'done' });
const _t4: JobProgress | null = normalizeJobProgress(ERROR_WIRE, { eventName: 'error' });
const _t5: JobProgress | null = normalizeJobProgress(SNAPSHOT_REPORTS, {
  eventName: 'snapshot',
  watchKind: 'report',
  reportBaseline: 1,
});
const _t6 = normalizeInsightList(INSIGHTS_ENVELOPE);
const _t7 = normalizeForecast(INSIGHTS_ENVELOPE.forecast);
const _t8: string = resolveInsightHref(SITE, INSIGHTS_ENVELOPE.actions[0].target, 'rank_drop');

// Silence unused warnings while keeping the checks live for tsc.
export const __contractChecks = [_t1, _t2, _t3, _t4, _t5, _t6, _t7, _t8];

export const __wireSiteId = SITE;
