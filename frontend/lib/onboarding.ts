/**
 * F-01 — Onboarding checklist (WIRED to the real backend, Wave 2).
 *
 * REAL CONTRACT (backend/src/routes/account.ts, merged on main):
 *   GET /api/v1/account/sites/:siteId/onboarding
 *   → { siteId, steps: [{ step, completed, completed_at }] }
 *   PUT /api/v1/account/sites/:siteId/onboarding  { step, completed }
 *   - step: 'verify_site' | 'connect_gsc' | 'first_crawl' |
 *           'add_keywords' | 'first_report'
 *
 * The backend state is the source of truth. Because nothing server-side
 * auto-marks steps, this module ALSO derives completion from real product
 * signals (site verified / GSC connected, a finished audit, any keyword,
 * any report) and persists newly-observed completions back with PUT
 * (best-effort) so the stored state stays truthful. Labels and hrefs are
 * presentation concerns and live here, not in the API.
 *
 * If the endpoint is unreachable (e.g. API down in local dev), the UI
 * falls back to the locally-derived steps and says so honestly via
 * `pendingBackend` — it never invents progress.
 */
import {
  auditsApi,
  keywordsApi,
  onboardingApi,
  reportsApi,
  sitesApi,
  type OnboardingStepKey,
  type Site,
} from './api';
import { ApiError } from './api';

export type OnboardingStatus = 'done' | 'current' | 'todo';

export interface OnboardingStep {
  key: OnboardingStepKey;
  label: string;
  status: OnboardingStatus;
  href: string;
}

export const ONBOARDING_KEYS: OnboardingStepKey[] = [
  'verify_site',
  'connect_gsc',
  'first_crawl',
  'add_keywords',
  'first_report',
];

const STEP_META: Record<OnboardingStepKey, { label: string; href: (siteId: string) => string }> = {
  verify_site: {
    label: 'Verify your site',
    href: (siteId) => `/dashboard/sites/new?siteId=${siteId}`,
  },
  connect_gsc: {
    label: 'Connect Search Console',
    href: (siteId) => `/dashboard/sites/${siteId}`,
  },
  first_crawl: {
    label: 'Run your first site audit',
    href: (siteId) => `/dashboard/sites/${siteId}/audit`,
  },
  add_keywords: {
    label: 'Add keywords to track',
    href: (siteId) => `/dashboard/sites/${siteId}/keywords`,
  },
  first_report: {
    label: 'Generate your first report',
    href: (siteId) => `/dashboard/sites/${siteId}/reports`,
  },
};

function toUiSteps(
  siteId: string,
  completedByKey: Partial<Record<OnboardingStepKey, boolean>>,
): OnboardingStep[] {
  const steps: OnboardingStep[] = ONBOARDING_KEYS.map((key) => ({
    key,
    label: STEP_META[key].label,
    status: completedByKey[key] ? 'done' : 'todo',
    href: STEP_META[key].href(siteId),
  }));
  const firstTodo = steps.findIndex((s) => s.status !== 'done');
  if (firstTodo >= 0) steps[firstTodo].status = 'current';
  return steps;
}

export function buildLocalSteps(site: Site): OnboardingStep[] {
  return toUiSteps(site.id, {
    verify_site: site.verified,
    connect_gsc: site.gsc_connected,
    first_crawl: false,
    add_keywords: false,
    first_report: false,
  });
}

/** Derive real completion signals from existing product APIs. */
export async function deriveCompletions(
  site: Site,
): Promise<Partial<Record<OnboardingStepKey, boolean>>> {
  const derived: Partial<Record<OnboardingStepKey, boolean>> = {
    verify_site: site.verified,
    // D3-L-4: the step is labeled "Connect Search Console" — a GA4-only
    // connection must not mark it done (matches buildLocalSteps below).
    connect_gsc: site.gsc_connected,
  };
  try {
    const [audits, keywords, reports] = await Promise.all([
      auditsApi.list(site.id),
      keywordsApi.list(site.id),
      reportsApi.list(site.id),
    ]);
    if ((audits.data ?? []).some((a) => a.status === 'done')) derived.first_crawl = true;
    if ((keywords.data ?? []).length > 0) derived.add_keywords = true;
    if ((reports.data ?? []).length > 0) derived.first_report = true;
  } catch {
    // Partial derivation failure: keep the site-flag-based signals.
  }
  return derived;
}

/** Enrich locally-computed steps with real progress from existing APIs. */
export async function enrichLocalSteps(site: Site): Promise<OnboardingStep[]> {
  return toUiSteps(site.id, await deriveCompletions(site));
}

/**
 * Load onboarding progress from the real backend endpoint. Newly observed
 * real-world completions are written back (PUT) so the backend remains
 * the source of truth; the returned steps reflect backend ∪ derived
 * state. `pendingBackend` is true ONLY when the endpoint could not be
 * reached and local derivation had to stand in for it.
 */
export async function loadOnboarding(
  siteId: string,
): Promise<{ steps: OnboardingStep[]; pendingBackend: boolean }> {
  let backendCompleted: Partial<Record<OnboardingStepKey, boolean>> | null = null;
  try {
    const state = await onboardingApi.get(siteId);
    backendCompleted = {};
    for (const s of state.steps) backendCompleted[s.step] = s.completed;
  } catch (e) {
    if (e instanceof ApiError && e.status !== 404 && e.status !== 0) throw e;
  }

  if (backendCompleted === null) {
    // Endpoint unavailable → honest local fallback from real APIs.
    const site = await sitesApi.get(siteId);
    return { steps: await enrichLocalSteps(site), pendingBackend: true };
  }

  // Reconcile with real product signals; persist any step the product
  // proves is done but the backend hasn't recorded yet.
  try {
    const site = await sitesApi.get(siteId);
    const derived = await deriveCompletions(site);
    const merged = { ...backendCompleted };
    for (const key of ONBOARDING_KEYS) {
      if (derived[key] && !merged[key]) {
        merged[key] = true;
        onboardingApi.setStep(siteId, key, true).catch(() => {
          // Best-effort write-back; the merged view is already truthful.
        });
      }
    }
    return { steps: toUiSteps(siteId, merged), pendingBackend: false };
  } catch {
    return { steps: toUiSteps(siteId, backendCompleted), pendingBackend: false };
  }
}
