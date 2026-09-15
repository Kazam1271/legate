'use client';

import { useMemo, useState } from 'react';

import { usd, utcDate } from '@/lib/format';

const RANGES = [
  { key: '7D', days: 7 },
  { key: '30D', days: 30 },
  { key: '90D', days: 90 },
  { key: 'All', days: Number.POSITIVE_INFINITY },
] as const;

type RangeKey = (typeof RANGES)[number]['key'];

const W = 960;
const H = 260;
const PAD_X = 8;
const PAD_Y = 16;

/**
 * NAV over time.
 *
 * Hand-rolled SVG rather than a charting library: the shape is simple, it keeps
 * the bundle small, and every path is computed from data that is fixed at
 * render time. Hover state starts null, so the first client render matches the
 * server's exactly.
 */
export function NavChart({ series, endsAt }: { series: number[]; endsAt: number }) {
  const [range, setRange] = useState<RangeKey>('90D');
  const [hover, setHover] = useState<number | null>(null);

  const points = useMemo(() => {
    const days = RANGES.find((r) => r.key === range)!.days;
    return Number.isFinite(days) ? series.slice(Math.max(0, series.length - days)) : series;
  }, [series, range]);

  const { line, area, min, max, coords } = useMemo(() => {
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;

    const coords = points.map((value, i) => {
      const x = (i / Math.max(1, points.length - 1)) * (W - PAD_X * 2) + PAD_X;
      const y = H - PAD_Y - ((value - min) / span) * (H - PAD_Y * 2);
      return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), value };
    });

    const line = coords.map((p, i) => (i === 0 ? 'M' : 'L') + p.x + ' ' + p.y).join(' ');
    const area =
      line + ' L' + coords[coords.length - 1].x + ' ' + H + ' L' + coords[0].x + ' ' + H + ' Z';

    return { line, area, min, max, coords };
  }, [points]);

  const active = hover === null ? null : coords[Math.min(hover, coords.length - 1)];
  const dayMs = 86_400_000;
  const firstDay = endsAt - (points.length - 1) * dayMs;

  function onMove(event: React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const index = Math.round(ratio * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, index)));
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="min-h-[42px]">
          {active ? (
            <>
              <p className="tnum font-mono text-lg text-fg">{usd(active.value)}</p>
              <p className="font-mono text-[11px] text-faint">
                {utcDate(firstDay + (hover ?? 0) * dayMs)}
              </p>
            </>
          ) : (
            <p className="font-mono text-[11px] text-faint">Hover the chart for a day&rsquo;s NAV</p>
          )}
        </div>

        <div className="flex gap-1" role="group" aria-label="Chart range">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              aria-pressed={range === r.key}
              className={
                'rounded-md px-2.5 py-1.5 font-mono text-xs transition-colors ' +
                (range === r.key ? 'bg-raised text-accent' : 'text-faint hover:text-muted')
              }
            >
              {r.key}
            </button>
          ))}
        </div>
      </div>

      <svg
        viewBox={'0 0 ' + W + ' ' + H}
        className="h-[260px] w-full touch-none"
        preserveAspectRatio="none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={'Net asset value per share over the last ' + points.length + ' days'}
      >
        <defs>
          <linearGradient id="navFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.20" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0.25, 0.5, 0.75].map((t) => (
          <line
            key={t}
            x1="0"
            x2={W}
            y1={PAD_Y + t * (H - PAD_Y * 2)}
            y2={PAD_Y + t * (H - PAD_Y * 2)}
            stroke="var(--color-line)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        <path d={area} fill="url(#navFill)" />
        <path
          d={line}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {active ? (
          <g>
            <line
              x1={active.x}
              x2={active.x}
              y1={PAD_Y}
              y2={H - PAD_Y}
              stroke="var(--color-line-strong)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={active.x} cy={active.y} r="3.5" fill="var(--color-accent)" vectorEffect="non-scaling-stroke" />
          </g>
        ) : null}
      </svg>

      <div className="mt-2 flex justify-between font-mono text-[10px] text-faint">
        <span className="tnum">{usd(min)}</span>
        <span className="tnum">{usd(max)}</span>
      </div>
    </div>
  );
}
