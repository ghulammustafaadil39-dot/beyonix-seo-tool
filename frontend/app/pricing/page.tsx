'use client';

import { useState } from 'react';
import Link from 'next/link';
import MarketingHeader from '@/components/MarketingHeader';
import Footer from '@/components/Footer';
import PlanCards, { type PlanId } from '@/components/PlanCards';
import Modal from '@/components/Modal';

const LIMIT_ROWS: Array<[string, string, string, string]> = [
  ['Sites', '1', '3', '10'],
  ['Keywords tracked', '50', '300', '1,000'],
  ['AI words / month', '5,000', '30,000', '100,000'],
  ['Rank check frequency', 'Weekly', 'Weekly', 'Daily'],
  ['AI visibility checks / month', '20', '100', '500'],
  ['Audits / month', '4', '12', '30'],
  ['Competitor analysis', '—', '✓', '✓'],
  ['White-label reports', '—', '—', '✓'],
  ['Agency workspaces', '—', '—', '✓'],
  ['API access', '—', '—', '✓'],
  ['Support', 'Email', 'Priority email', 'Priority email + Slack'],
];

/**
 * F-11 — public pricing page. Signup is the CTA for each plan; the
 * dashboard billing page handles upgrades for existing customers.
 * Coupon entry happens at Stripe checkout.
 */
export default function PricingPage() {
  const [annual, setAnnual] = useState(false);
  const [couponInfo, setCouponInfo] = useState(false);

  return (
    <div className="min-h-screen bg-[#04090c] text-white">
      <MarketingHeader />
      <main>
        <section className="bx-glow">
          <div className="relative mx-auto max-w-6xl px-4 pb-10 pt-20 text-center">
            <p className="bx-micro mb-4">~/ pricing</p>
            <h1 className="mx-auto max-w-2xl text-4xl font-extrabold tracking-tight sm:text-5xl">
              Plans that grow with your business
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-white/60">
              Every plan starts with a free trial — no credit card required.
              Upgrade, downgrade, or cancel anytime.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-8">
          <PlanCards
            currentPlan={null}
            annual={annual}
            onToggleAnnual={setAnnual}
            action={(plan: PlanId) => (
              <Link
                href={`/signup?plan=${plan}&billing=${annual ? 'annual' : 'monthly'}`}
                className="bx-btn-primary w-full"
              >
                Start free with {plan.charAt(0).toUpperCase() + plan.slice(1)}
              </Link>
            )}
          />
          <div className="mt-6 text-center">
            <button onClick={() => setCouponInfo(true)} className="bx-link text-sm">
              Have a coupon code?
            </button>
          </div>
        </section>

        {/* Full comparison table */}
        <section className="mx-auto max-w-6xl px-4 py-16">
          <h2 className="text-center text-2xl font-bold tracking-tight">
            Compare everything
          </h2>
          <div className="bx-table-wrap mt-8">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="bx-th">Feature</th>
                  <th className="bx-th">Starter</th>
                  <th className="bx-th">Growth</th>
                  <th className="bx-th">Pro</th>
                </tr>
              </thead>
              <tbody className="bx-tbody">
                {LIMIT_ROWS.map(([feature, s, g, p]) => (
                  <tr key={feature}>
                    <td className="px-4 py-3 font-medium text-white/80">{feature}</td>
                    {[s, g, p].map((v, i) => (
                      <td
                        key={i}
                        className={`px-4 py-3 font-mono ${
                          v === '—' ? 'text-white/25' : 'text-white/70'
                        }`}
                      >
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* FAQ */}
        <section className="mx-auto max-w-3xl px-4 pb-20">
          <h2 className="text-center text-2xl font-bold tracking-tight">FAQ</h2>
          <div className="mt-8 space-y-4">
            {[
              {
                q: 'What happens when I hit a usage limit?',
                a: 'That feature pauses gracefully until your next billing period or an upgrade — nothing is deleted, and we warn you at 80% and 100%.',
              },
              {
                q: 'Can I switch between monthly and annual?',
                a: 'Yes — change billing cadence anytime from your billing page; the switch is prorated automatically.',
              },
              {
                q: 'Do you offer refunds?',
                a: 'If the product isn\u2019t for you, contact support within 14 days of your first payment for a full refund.',
              },
            ].map((f) => (
              <details key={f.q} className="bx-card">
                <summary className="cursor-pointer list-none text-sm font-semibold text-white marker:hidden [&::-webkit-details-marker]:hidden">
                  {f.q}
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-white/60">{f.a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      {couponInfo && (
        <Modal title="Coupon codes" onClose={() => setCouponInfo(false)}>
          <p className="text-sm text-white/70">
            Coupons are applied at checkout — enter your code on the Stripe
            checkout page after choosing a plan, and the discount is applied
            before you pay.
          </p>
          <div className="mt-4 text-right">
            <button onClick={() => setCouponInfo(false)} className="bx-btn-primary">
              Got it
            </button>
          </div>
        </Modal>
      )}

      <Footer />
    </div>
  );
}
