/**
 * F-01 — Onboarding checklist.
 *
 * CONTRACT (frozen, Backend Lead to implement):
 *   GET /api/v1/sites/:id/onboarding
 *   → { steps: [{ key, label, status, href }] }
 *   - key:    'verify_site' | 'connect_sources' | 'first_crawl' |
 *             'add_keywords' | 'first_report'
 *   - label:  human-readable step title
 *   - status: 'done' | 'current' | 'todo'
 *   - href:   where the step is completed, e.g. '/dashboard/sites/<id>'
 *
 * Until the endpoint lands, the UI falls back to computing the same
 * shape LOCALLY from existing APIs (verify/gsc flags, audits list,
 * keywords list, reports list) — real data, no fake values. The first
 * not-done step becomes 'current'; the rest stay 'todo'.
 */
import {
  auditsApi,
  keywordsApi,
  reportsApi,
  sitesApi,
  type Site,
} from './api';
import { ApiError } from './api';

export type OnboardingStatus = 'done' | 'current' | 'todo';

export interface OnboardingStep {
  key: 'verify_site' | 'connect_sources' | 'first_crawl' | 'add_keywords' | 'first_report';
  label: string;
  status: OnboardingStatus;
  href: string;
}

export interface OnboardingResponse {
  steps: OnboardingStep[];
}

export const ONBOARDING_KEYS = [
  'verify_site',
  'connect_sources',
  'first_crawl',
  'add_keywords',
  'first_report',
] as const;

export function buildLocalSteps(site: Site): OnboardingStep[] {
  const steps: OnboardingStep[] = [
    {
      key: 'verify_site',
      label: 'Verify your site',
      status: site.verified ? 'done' : 'todo',
      href: `/dashboard/sites/new?siteId=${site.id}`,
    },
    {
      key: 'connect_sources',
      label: 'Connect Search Console or Analytics',
      status: site.gsc_connected || site.ga4_connected ? 'done' : 'todo',
      href: `/dashboard/sites/${site.id}`,
    },
    {
      key: 'first_crawl',
      label: 'Run your first site audit',
      status: 'todo',
      href: `/dashboard/sites/${site.id}/audit`,
    },
    {
      key: 'add_keywords',
      label: 'Add keywords to track',
      status: 'todo',
      href: `/dashboard/sites/${site.id}/keywords`,
    },
    {
      key: 'first_report',
      label: 'Generate your first report',
      status: 'todo',
      href: `/dashboard/sites/${site.id}/reports`,
    },
  ];
  // First incomplete step is the "current" one the user should do next.
  const firstTodo = steps.findIndex((s) => s.status !== 'done');
  if (firstTodo >= 0) steps[firstTodo].status = 'current';
  return steps;
}

/** Enrich locally-computed steps with real progress from existing APIs. */
export async function enrichLocalSteps(site: Site): Promise<OnboardingStep[]> {
  const steps = buildLocalSteps(site);
  try {
    const [audits, keywords, reports] = await Promise.all([
      auditsApi.list(site.id),
      keywordsApi.list(site.id),
      reportsApi.list(site.id),
    ]);
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
    if ((audits.data ?? []).some((a) => a.status === 'done')) byKey.first_crawl.status = 'done';
    if ((keywords.data ?? []).length > 0) byKey.add_keywords.status = 'done';
    if ((reports.data ?? []).length > 0) byKey.first_report.status = 'done';
    const firstTodo = steps.findIndex((s) => s.status !== 'done');
    steps.forEach((s) => {
      if (s.status === 'current') s.status = 'todo';
    });
    if (firstTodo >= 0) steps[firstTodo].status = 'current';
  } catch {
    // Partial enrichment failure: keep the site-flag-based steps.
  }
  return steps;
}

/**
 * Load onboarding progress: real endpoint when it exists, local fallback
 * otherwise. `pendingBackend` is true when the contract endpoint hasn't
 * landed yet (reported honestly, never silently).
 */
export async function loadOnboarding(
  siteId: string,
): Promise<{ steps: OnboardingStep[]; pendingBackend: boolean }> {
  try {
    const res = await fetch(`/api/v1/sites/${siteId}/onboarding`, {
      credentials: 'include',
    });
    if (res.ok) {
      const json = (await res.json()) as OnboardingResponse;
      if (Array.isArray(json.steps)) {
        return { steps: json.steps, pendingBackend: false };
      }
    }
    throw new ApiError({
      code: 'ONBOARDING_UNAVAILABLE',
      message: 'Onboarding endpoint not available',
      status: res.status,
    });
  } catch (e) {
    // Backend not landed yet (404/501/network) → honest local fallback.
    if (e instanceof ApiError && e.status !== 404 && e.status !== 501 && e.status !== 0) throw e;
    const site = await sitesApi.get(siteId);
    return { steps: await enrichLocalSteps(site), pendingBackend: true };
  }
}
