/** Circular score gauge (0-100), teal → amber → red on dark. */
export default function ScoreGauge({
  score,
  label,
  size = 120,
}: {
  score: number | null;
  label?: string;
  size?: number;
}) {
  const s = score ?? 0;
  const radius = (size - 16) / 2;
  const circumference = 2 * Math.PI * radius;
  const color = s >= 80 ? '#2dd4bf' : s >= 50 ? '#fbbf24' : '#f87171';

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} aria-label={label ?? `score ${s}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="10"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${(s / 100) * circumference} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ filter: `drop-shadow(0 0 6px ${color}66)` }}
        />
        <text
          x="50%"
          y="50%"
          dominantBaseline="middle"
          textAnchor="middle"
          fill="#ffffff"
          fontSize={size * 0.24}
          fontWeight="bold"
          fontFamily="'JetBrains Mono', monospace"
        >
          {score === null ? '—' : s}
        </text>
      </svg>
      {label && <p className="text-sm font-medium text-white/60">{label}</p>}
    </div>
  );
}
