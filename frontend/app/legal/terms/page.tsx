import type { Metadata } from 'next';
import { LegalLayout, LegalSection } from '@/components/LegalLayout';

export const metadata: Metadata = {
  title: 'Terms of service',
  description: 'Terms of service for Beyonix SEO.',
  alternates: { canonical: '/legal/terms' },
};

export default function TermsPage() {
  return (
    <LegalLayout title="Terms of service" updated="2026-10-11">
      <LegalSection heading="1. The service">
        <p>
          Beyonix SEO (“the service”) is a subscription software-as-a-service product by Beyonix
          Solutions that provides website audits, keyword research, rank tracking, AI-generated
          content assistance, AI-visibility (GEO) tracking, backlink analysis, and reporting.
        </p>
        <p>
          By creating an account you agree to these terms. If you use the service on behalf of a
          company, you confirm you are authorized to accept these terms for it.
        </p>
      </LegalSection>
      <LegalSection heading="2. Accounts and acceptable use">
        <p>You must provide accurate account information and keep your credentials secure.</p>
        <p>
          You may not: crawl or audit sites you do not own or have permission to audit; use the
          service to send spam or unsolicited messages; attempt to access other tenants’ data;
          reverse-engineer usage limits; or use AI-generated content in ways that violate
          applicable law.
        </p>
      </LegalSection>
      <LegalSection heading="3. Plans, billing, and usage limits">
        <p>
          Plans are billed monthly or annually in advance through our payment processor (Stripe).
          Each plan includes usage limits (sites, tracked keywords, AI words, rank checks, and so
          on). When a limit is reached, the affected feature pauses until the next billing period
          or an upgrade — your existing data is never deleted because of a limit.
        </p>
        <p>
          You can upgrade, downgrade, or cancel anytime from the billing page. Downgrades take
          effect at the end of the current billing period. Refunds are granted within 14 days of
          the first payment on request.
        </p>
      </LegalSection>
      <LegalSection heading="4. Data and content">
        <p>
          You retain ownership of your data (site data, keywords, content drafts, reports). You
          can export it anytime and request deletion of your account and data.
        </p>
        <p>
          AI-generated drafts are suggestions, not professional advice. Review generated content
          before publishing — you are responsible for what you publish.
        </p>
      </LegalSection>
      <LegalSection heading="5. Fair use of third-party data">
        <p>
          Rank tracking and AI-visibility data come from licensed providers and official APIs.
          Availability of third-party data may change; we will substitute or clearly label
          simulated data where a provider is unavailable.
        </p>
      </LegalSection>
      <LegalSection heading="6. Warranties and liability">
        <p>
          The service is provided “as is”. We do not guarantee specific search ranking results —
          nobody honest can. To the maximum extent permitted by law, our liability is limited to
          the fees you paid in the 12 months before the claim.
        </p>
      </LegalSection>
      <LegalSection heading="7. Changes and contact">
        <p>
          We may update these terms; material changes will be announced by email at least 14 days
          in advance. Contact: support@beyonixsolutions.com.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
