/**
 * Q-03: basic /status page. Server component — reads the API's /status JSON
 * server-side (API_INTERNAL_URL) so the page renders even when the API is
 * on an internal hostname. Frontend Lead owns UI polish; this keeps to a
 * functional, accessible data table.
 */
async function getStatus(): Promise<any> {
  const base =
    process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    return { data: await res.json(), ok: res.ok };
  } catch (e) {
    return { data: null, ok: false, error: (e as Error).message };
  }
}

export default async function StatusPage() {
  const { data, ok, error } = await getStatus();
  const queues: Record<string, any> = data?.queues ?? {};
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-bold">System status</h1>
      <p className="mt-2 text-sm text-gray-600">
        Live service state from the API (<code>/status</code>). Public, no
        tenant data is ever included.
      </p>
      {!ok ? (
        <div role="alert" className="mt-6 rounded border border-red-300 bg-red-50 p-4">
          <p className="font-semibold">API unreachable</p>
          <p className="text-sm">{error ?? 'unknown error'}</p>
        </div>
      ) : (
        <>
          <table className="mt-6 w-full text-sm" aria-label="Service health">
            <tbody>
              <tr className="border-b">
                <td className="py-2 font-medium">Overall</td>
                <td>{data.ok ? 'Operational' : 'Degraded'}</td>
              </tr>
              <tr className="border-b">
                <td className="py-2 font-medium">Database</td>
                <td>{data.services?.db ? 'OK' : 'DOWN'}</td>
              </tr>
              <tr className="border-b">
                <td className="py-2 font-medium">Redis</td>
                <td>{data.services?.redis ? 'OK' : 'DOWN'}</td>
              </tr>
              <tr className="border-b">
                <td className="py-2 font-medium">Dead-letter jobs pending</td>
                <td>{data.deadLettersPending ?? '—'}</td>
              </tr>
            </tbody>
          </table>
          <h2 className="mt-8 text-lg font-semibold">Queue depth</h2>
          <table className="mt-2 w-full text-sm" aria-label="Queue depth">
            <thead>
              <tr className="border-b text-left">
                <th className="py-2">Queue</th>
                <th>Waiting</th>
                <th>Active</th>
                <th>Delayed</th>
                <th>Failed</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(queues).map(([name, c]: [string, any]) => (
                <tr key={name} className="border-b">
                  <td className="py-2 font-medium">{name}</td>
                  <td>{c.waiting}</td>
                  <td>{c.active}</td>
                  <td>{c.delayed}</td>
                  <td>{c.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-8 text-xs text-gray-500">
            Updated {data.time ? new Date(data.time).toLocaleString() : '—'}
          </p>
        </>
      )}
    </main>
  );
}
