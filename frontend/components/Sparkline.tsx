/** Tiny SVG sparkline for ranking history (lower position = better). */
export default function Sparkline({
  points,
  width = 120,
  height = 32,
}: {
  points: (number | null)[];
  width?: number;
  height?: number;
}) {
  const vals = points.filter((p): p is number => p !== null && p > 0);
  if (vals.length === 0)
    return <span className="text-xs text-white/30">no data</span>;

  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const span = Math.max(1, max - min);

  // y is inverted so rank 1 sits at the top
  const coords = points.map((p, i) => {
    const x = (i / Math.max(1, points.length - 1)) * width;
    const v = p && p > 0 ? p : max;
    const y = ((v - min) / span) * (height - 4) + 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg width={width} height={height} className="inline-block" aria-hidden>
      <polyline
        points={coords.join(' ')}
        fill="none"
        stroke="#2dd4bf"
        strokeWidth="1.5"
      />
    </svg>
  );
}
