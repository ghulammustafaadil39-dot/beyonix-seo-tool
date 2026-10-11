'use client';

/**
 * F-11 — shared plan comparison cards with annual/monthly toggle.
 * Used by the public /pricing page and the dashboard billing page.
 *
 * Prices are illustrative; Stripe checkout shows the final price.
 * Feature bullets mirror backend/src/plans.ts (single source of truth).
 */
import { PLAN_NAMES } from '@/lib/api';

export type PlanId = 'starter' | 'growth' | 'pro';

export const PLAN_IDS: PlanId[] = ['starter', 'growth', 'pro'];

export const PLAN_DESCRIPTIONS: Record<PlanId, string> = {
  starter: 'For a single small business site getting SEO off the ground.',
  growth: 'For growing businesses with multiple sites and bigger ambitions.',
  pro: 'For businesses that want daily tracking and serious content output.',
};

export const PLAN_FEATURES: Record<PlanId, string[]> = {
  starter: [
    '1 site',
    '50 keywords tracked',
    '5,000 AI words / month',
    'Weekly rank checks',
    '20 AI visibility checks / month',
    'Weekly email report',
  ],
  growth: [
    '3 sites',
    '300 keywords tracked',
    '30,000 AI words / month',
    'Weekly rank checks',
    '100 AI visibility checks / month',
    'Competitor analysis',
    'Client share links',
  ],
  pro: [
    '10 sites',
    '1,000 keywords tracked',
    '100,000 AI words / month',
    'Daily rank checks',
    '500 AI visibility checks / month',
    'White-label reports',
    'Agency workspaces & API access',
  ],
};

// Placeholder monthly prices (USD). Stripe is the source of truth at checkout.
const PLAN_PRICES: Record<PlanId, { monthly: number; annual: number }> = {
  starter: { monthly: 29, annual: 290 },
  growth: { monthly: 79, annual: 790 },
  pro: { monthly: 179, annual: 1790 },
};

export function planPrice(plan: PlanId, annual: boolean): string {
  const p = PLAN_PRICES[plan];
  const total = annual ? p.annual : p.monthly * 12;
  const monthly = annual ? Math.round(p.annual / 12) : p.monthly;
  return `$${monthly}/mo${annual ? ` · $${total}/yr` : ''}`;
}

export default function PlanCards({
  currentPlan,
  annual,
  onToggleAnnual,
  action,
  showToggle = true,
}: {
  currentPlan: PlanId | null;
  annual: boolean;
  onToggleAnnual: (v: boolean) => void;
  /**
   * Rendered per plan: e.g. checkout button on /pricing, plan-change
   * button in the dashboard. Receives (plan, isCurrent).
   */
  action: (plan: PlanId, isCurrent: boolean) => React.ReactNode;
  /** Dashboard hides the toggle — cadence changes happen in the portal. */
  showToggle?: boolean;
}) {
  return (
    <div>
      {showToggle && (
      <div className="mb-6 flex items-center justify-center gap-3">
        <span className={`text-sm font-medium ${!annual ? 'text-white' : 'text-white/50'}`}>
          Monthly
        </span>
        <button
          role="switch"
          aria-checked={annual}
          aria-label="Toggle annual billing"
          onClick={() => onToggleAnnual(!annual)}
          className={`relative h-6 w-11 rounded-full transition ${
            annual ? 'bg-teal-400' : 'bg-white/15'
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
              annual ? 'left-[22px]' : 'left-0.5'
            }`}
          />
        </button>
        <span className={`text-sm font-medium ${annual ? 'text-white' : 'text-white/50'}`}>
          Annual
        </span>
        <span className="bx-pill bx-pill-ok">
          <span className="bx-dot" />
          2 months free
        </span>
      </div>
      )}

      <div className="grid gap-5 md:grid-cols-3">
        {PLAN_IDS.map((plan) => {
          const isCurrent = currentPlan === plan;
          const popular = plan === 'growth';
          return (
            <div
              key={plan}
              className={`relative flex flex-col rounded-xl border p-6 ${
                isCurrent || popular
                  ? 'bx-glow border-teal-400/40 bg-[#06141d]'
                  : 'border-white/10 bg-[#06141d]'
              }`}
            >
              {popular && !isCurrent && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-cyan-300 to-teal-400 px-3 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wider text-[#04181a]">
                  Most popular
                </span>
              )}
              <h3 className="text-lg font-bold text-white">{PLAN_NAMES[plan]}</h3>
              <p className="mt-2">
                <span className="bg-gradient-to-r from-cyan-300 to-teal-400 bg-clip-text text-3xl font-extrabold text-transparent">
                  {planPrice(plan, annual)}
                </span>
              </p>
              <p className="mt-1 font-mono text-xs text-white/40">
                {annual ? 'billed annually' : 'billed monthly'} · cancel anytime
              </p>
              <p className="mt-3 text-sm text-white/60">{PLAN_DESCRIPTIONS[plan]}</p>
              <ul className="mt-4 flex-1 space-y-2 font-mono text-xs text-white/70">
                {PLAN_FEATURES[plan].map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <span className="mt-0.5 text-teal-300" aria-hidden="true">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-6">{action(plan, isCurrent)}</div>
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-center font-mono text-xs text-white/30">
        Final price is confirmed securely at Stripe checkout.
      </p>
    </div>
  );
}
