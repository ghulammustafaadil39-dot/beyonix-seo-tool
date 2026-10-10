import type { ReactNode } from 'react';

export default function StatCard({
  label,
  value,
  hint,
  children,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="bx-card">
      <p className="bx-micro">{label}</p>
      <p className="mt-2 font-mono text-3xl font-bold text-white">{value}</p>
      {hint && <p className="mt-1 text-xs text-white/40">{hint}</p>}
      {children}
    </div>
  );
}
