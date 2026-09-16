'use client';

import { useEffect, useRef, useState } from 'react';

import { num, ratioPct, usdCompact } from '@/lib/format';

/**
 * A closure can't cross the server/client boundary — a page.tsx that passed
 * `format={usdCompact}` would fail at build with "Functions cannot be passed
 * directly to Client Components." So the formatter is chosen from this fixed,
 * serialisable set instead, by name, and resolved in here where the client
 * boundary already starts.
 */
const FORMATTERS = {
  int: (n: number) => num(n, 0),
  usdCompact,
  ratioPct: (n: number) => ratioPct(n),
} as const;

export type CountUpFormat = keyof typeof FORMATTERS;

/**
 * Animates a number from 0 up to `value` the moment it scrolls into view,
 * landing exactly on the real figure — never a rounding-drifted approximation,
 * since the tween runs on the raw number and reformats it every frame.
 *
 * Hydration-safe by construction: state starts at `value`, so the server
 * render and the client's very first paint show the identical real number.
 * Only inside a `useEffect` — which never runs during SSR — does an
 * IntersectionObserver arm the animation, briefly resetting to 0 and tweening
 * back up. A visitor without JS, or one who never scrolls this far, sees the
 * correct number the whole time; nothing here depends on script for
 * correctness, only for the reveal.
 */
export function CountUp({
  value,
  format,
  durationMs = 900,
}: {
  value: number;
  format: CountUpFormat;
  durationMs?: number;
}) {
  const formatFn = FORMATTERS[format];
  const [display, setDisplay] = useState(value);
  const ref = useRef<HTMLSpanElement>(null);
  const played = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || played.current) return;
        played.current = true;
        observer.disconnect();

        const start = performance.now();
        // Fast start, gentle landing — reads as quick without a jarring stop.
        const ease = (t: number) => 1 - Math.pow(1 - t, 3);

        function tick(now: number) {
          const t = Math.min(1, (now - start) / durationMs);
          setDisplay(t < 1 ? value * ease(t) : value);
          if (t < 1) requestAnimationFrame(tick);
        }

        setDisplay(0);
        requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [value, durationMs]);

  return (
    <span ref={ref} className="tnum">
      {formatFn(display)}
    </span>
  );
}
