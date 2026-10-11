import type { Metadata } from 'next';
import { LegalLayout, LegalSection } from '@/components/LegalLayout';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description: 'Privacy policy for Beyonix SEO: what data we collect, why, and your rights.',
  alternates: { canonical: '/legal/privacy' },
};

export default function PrivacyPage() {
  return (
    <LegalLayout title="Privacy policy" updated="2026-10-11">
      <LegalSection heading="1. What we collect">
        <p>
          <strong className="text-white">Account data:</strong> name, email, password hash (never
          the password itself), and billing details handled by our payment processor (Stripe — we
          never see or store your card number).
        </p>
        <p>
          <strong className="text-white">Site data:</strong> domains you add, crawled page
          content, audit results, keywords, rankings, backlinks, AI-visibility checks, and content
          drafts you create.
        </p>
        <p>
          <strong className="text-white">Connected accounts:</strong> if you connect Google Search
          Console or Analytics, we store OAuth tokens to fetch your search and traffic data.
          Tokens are encrypted at rest; disconnecting deletes them immediately.
        </p>
        <p>
          <strong className="text-white">Usage data:</strong> feature usage for metering and
          billing (e.g. pages crawled, AI words generated), plus basic operational logs.
        </p>
      </LegalSection>
      <LegalSection heading="2. Why we use it">
        <p>
          To provide the service (crawls, rankings, reports), bill you correctly, keep the
          service secure, and improve it. We do not sell your data and we do not use your site
          data to train models for other customers.
        </p>
      </LegalSection>
      <LegalSection heading="3. Cookies">
        <p>
          We use only essential cookies: the session cookie that keeps you
          logged in (and its CSRF-protection companion), plus a local record
          of your cookie-banner choice. We do not set analytics, advertising,
          or tracking cookies.
        </p>
      </LegalSection>
      <LegalSection heading="4. Sub-processors">
        <p>
          We share limited data with sub-processors who help run the service: payment processing
          (Stripe), SERP and AI-visibility data providers (e.g. DataForSEO), LLM providers for
          content generation, and infrastructure hosting. Each only receives what it needs.
        </p>
      </LegalSection>
      <LegalSection heading="5. Your rights">
        <p>
          Access, correct, export, or delete your data anytime from your account settings, or
          email privacy@beyonixsolutions.com. Deleting your account permanently deletes your
          tenant data within 30 days.
        </p>
      </LegalSection>
      <LegalSection heading="6. Data retention and security">
        <p>
          Raw crawl and SERP snapshots are retained per our published retention schedule, then
          deleted. Data is encrypted in transit and at rest; access is tenant-scoped and logged.
        </p>
      </LegalSection>
      <LegalSection heading="7. Contact">
        <p>
          Questions about privacy: privacy@beyonixsolutions.com. We will respond within 30 days.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
