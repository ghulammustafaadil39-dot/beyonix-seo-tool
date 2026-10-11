// W-05: skeleton loading states — brand-shimmer placeholders used in place
// of bare spinners/text on the data-heavy screens. aria-hidden; each
// consumer pairs the skeleton with an sr-only status or a labelled region.
'use client';

function Shimmer({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`bx-shimmer rounded-md bg-white/5 ${className}`}
    />
  );
}

/** Line skeleton used inside cards; widths cycle for a natural look. */
export function SkeletonLines({ rows = 3, className = '' }: { rows?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <Shimmer key={i} className={`h-3 ${i % 3 === 2 ? 'w-2/3' : 'w-full'}`} />
      ))}
    </div>
  );
}

/** Card grid skeleton (dashboard sites list). */
export function SiteGridSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div role="status" aria-label="Loading sites" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bx-card space-y-3">
          <Shimmer className="h-5 w-2/3" />
          <div className="flex gap-2">
            <Shimmer className="h-5 w-20 !rounded-full" />
            <Shimmer className="h-5 w-28 !rounded-full" />
          </div>
          <Shimmer className="h-8 w-28" />
        </div>
      ))}
    </div>
  );
}

/** Stat-card row skeleton (site overview). */
export function StatRowSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div role="status" aria-label="Loading stats" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bx-card">
          <Shimmer className="h-3 w-20" />
          <Shimmer className="mt-2 h-7 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Table skeleton (audit issues, keywords, rankings…). */
export function TableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="Loading table" className="bx-table-wrap">
      <div className="space-y-3 p-4">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex gap-3">
            {Array.from({ length: cols }).map((_, c) => (
              <Shimmer key={c} className={`h-4 ${c === 1 ? 'flex-1' : 'w-24'}`} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Gauge/panel skeleton (health score, GEO score…). */
export function GaugeSkeleton() {
  return (
    <div role="status" aria-label="Loading score" className="bx-card">
      <Shimmer className="mb-4 h-3 w-28" />
      <div className="flex justify-center">
        <div aria-hidden="true" className="bx-shimmer h-32 w-32 rounded-full bg-white/5" />
      </div>
    </div>
  );
}

/** Page-header skeleton (title + action button). */
export function PageHeaderSkeleton() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3" aria-hidden="true">
      <div className="space-y-2">
        <Shimmer className="h-3 w-24" />
        <Shimmer className="h-6 w-48" />
      </div>
      <Shimmer className="h-9 w-32" />
    </div>
  );
}
