'use client';

import { useState } from 'react';
import { sitesApi } from '@/lib/api';
import { useErrorReporter } from './ErrorBanner';

/** Inline "Add site" form used on the dashboard; reports success via onAdded. */
export default function AddSiteForm({ onAdded }: { onAdded: () => void }) {
  const { report } = useErrorReporter();
  const [domain, setDomain] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await sitesApi.create(domain.trim());
      setDomain('');
      onAdded();
    } catch (err) {
      report(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
      <input
        type="text"
        required
        value={domain}
        onChange={(e) => setDomain(e.target.value)}
        placeholder="example.com"
        className="bx-input"
      />
      <button type="submit" disabled={loading} className="bx-btn-primary shrink-0">
        {loading ? 'Adding…' : 'Add site'}
      </button>
    </form>
  );
}
