/**
 * Tiny NAV sparkline. Pure SVG, no charting dependency — the series is known at
 * render time, so there is nothing to compute in the browser and nothing that
 * can render differently there.
 */
export function Sparkline({
  series,
  positive,
  width = 132,
  height = 34,
}: {
  series: number[];
  positive: boolean;
  width?: number;
  height?: number;
}) {
  if (series.length < 2) return null;

  // Thin a long series; more points than pixels only costs bytes.
  const step = Math.max(1, Math.floor(series.length / width));
  const points = series.filter((_, i) => i % step === 0 || i === series.length - 1);

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const pad = 2;

  const coords = points.map((value, i) => {
    const x = (i / (points.length - 1)) * (width - pad * 2) + pad;
    const y = height - pad - ((value - min) / span) * (height - pad * 2);
    return [Number(x.toFixed(2)), Number(y.toFixed(2))] as const;
  });

  const line = coords.map(([x, y], i) => (i === 0 ? 'M' : 'L') + x + ' ' + y).join(' ');
  const stroke = positive ? 'var(--color-positive)' : 'var(--color-negative)';

  return (
    <svg
      viewBox={'0 0 ' + width + ' ' + height}
      width={width}
      height={height}
      className="overflow-visible"
      role="img"
      aria-label={positive ? 'Net asset value trending up' : 'Net asset value trending down'}
    >
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={coords[coords.length - 1][0]} cy={coords[coords.length - 1][1]} r="2" fill={stroke} />
    </svg>
  );
}
