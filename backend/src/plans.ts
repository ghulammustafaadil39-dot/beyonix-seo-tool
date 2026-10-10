// Plan definitions — single source of truth for limits.
export const PLANS = {
  starter: {
    name: 'Starter',
    max_sites: 1,
    max_keywords_tracked: 50,
    ai_words_month: 5_000,
    crawl_pages: 100,
    crawl_pages_month: 400,
    rankcheck_freq: 'weekly' as const,
    geo_checks_month: 20,
    serp_checks_month: 500,
    keyword_metrics_month: 500,
  },
  growth: {
    name: 'Growth',
    max_sites: 3,
    max_keywords_tracked: 300,
    ai_words_month: 30_000,
    crawl_pages: 500,
    crawl_pages_month: 2000,
    rankcheck_freq: 'weekly' as const,
    geo_checks_month: 100,
    serp_checks_month: 2000,
    keyword_metrics_month: 2000,
  },
  pro: {
    name: 'Pro',
    max_sites: 10,
    max_keywords_tracked: 1000,
    ai_words_month: 100_000,
    crawl_pages: 2000,
    crawl_pages_month: 8000,
    rankcheck_freq: 'daily' as const,
    geo_checks_month: 500,
    serp_checks_month: 6000,
    keyword_metrics_month: 6000,
  },
} as const;

export type PlanId = keyof typeof PLANS;

export function getPlan(planId: string): (typeof PLANS)[PlanId] {
  return (PLANS as Record<string, (typeof PLANS)[PlanId]>)[planId] ?? PLANS.starter;
}

export function isPlanId(v: string): v is PlanId {
  return v === 'starter' || v === 'growth' || v === 'pro';
}
