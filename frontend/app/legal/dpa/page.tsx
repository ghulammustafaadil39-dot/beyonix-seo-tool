import type { Metadata } from 'next';
import { LegalLayout, LegalSection } from '@/components/LegalLayout';

export const metadata: Metadata = {
  title: 'Data processing agreement',
  description: 'Data processing agreement (DPA) for Beyonix SEO customers.',
  alternates: { canonical: '/legal/dpa' },
};

export default function DpaPage() {
  return (
    <LegalLayout title="Data processing agreement" updated="2026-10-11">
      <LegalSection heading="1. Scope">
        <p>
          This Data Processing Agreement (“DPA”) applies where Beyonix Solutions processes
          personal data on behalf of a customer (“Controller”) in providing the Beyonix SEO
          service (“Processor” role). It forms part of the Terms of Service.
        </p>
      </LegalSection>
      <LegalSection heading="2. Subject matter and duration">
        <p>
          Processing covers account data, crawled site content, keyword/ranking data, and
          connected Google account data, for the duration of the subscription plus a 30-day
          deletion window after termination.
        </p>
      </LegalSection>
      <LegalSection heading="3. Processor obligations">
        <p>
          We process data only on documented instructions from the Controller; ensure persons
          processing data are bound by confidentiality; implement appropriate technical and
          organizational measures (encryption in transit and at rest, tenant isolation, access
          logging); and assist the Controller with data-subject requests.
        </p>
      </LegalSection>
      <LegalSection heading="4. Sub-processors">
        <p>
          Current sub-processors: payment processing (Stripe), SERP/AI-visibility data providers
          (e.g. DataForSEO), LLM providers for content features, and infrastructure hosting. We
          will notify customers of sub-processor changes at least 14 days in advance; objections
          may be raised at privacy@beyonixsolutions.com.
        </p>
      </LegalSection>
      <LegalSection heading="5. Security incidents">
        <p>
          We will notify the Controller without undue delay (and within 72 hours of becoming
          aware) of any personal data breach affecting their data, with the nature, categories,
          and mitigation steps.
        </p>
      </LegalSection>
      <LegalSection heading="6. International transfers">
        <p>
          Where data is transferred outside the customer’s jurisdiction, we rely on appropriate
          safeguards (such as standard contractual clauses) and document them on request.
        </p>
      </LegalSection>
      <LegalSection heading="7. Deletion and return">
        <p>
          On termination, customer data is deleted within 30 days (backups within 90 days).
          Export tools are available throughout the subscription for data return.
        </p>
      </LegalSection>
      <LegalSection heading="8. Audit">
        <p>
          Once per year, the Controller may request a summary of our security controls and
          recent audit evidence relevant to this DPA.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
