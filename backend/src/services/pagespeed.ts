// Google PageSpeed Insights — real Core Web Vitals for the homepage.
// Free tier (no key required for our volume; PAGESPEED_API_KEY optional).
// Best-effort: never fails the audit when the API is unreachable.

export interface PageSpeedMetrics {
  lcpMs: number | null; // Largest Contentful Paint
  cls: number | null; // Cumulative Layout Shift
  inpMs: number | null; // Interaction to Next Paint
  performanceScore: number | null; // 0-100 Lighthouse performance
}

const API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

export async function getPageSpeedMetrics(pageUrl: string, apiKey?: string): Promise<PageSpeedMetrics | null> {
  try {
    const params = new URLSearchParams({ url: pageUrl, strategy: 'mobile', category: 'performance' });
    if (apiKey) params.set('key', apiKey);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    let res: Response;
    try {
      res = await fetch(`${API}?${params.toString()}`, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const data: any = await res.json();
    const audits = data?.lighthouseResult?.audits ?? {};
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    const score = data?.lighthouseResult?.categories?.performance?.score;
    return {
      lcpMs: num(audits['largest-contentful-paint']?.numericValue),
      cls: num(audits['cumulative-layout-shift']?.numericValue),
      inpMs: num(audits['interaction-to-next-paint']?.numericValue),
      performanceScore: typeof score === 'number' ? Math.round(score * 100) : null,
    };
  } catch {
    return null;
  }
}
