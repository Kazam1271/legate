'use client';

import { useEffect, useState } from 'react';

import { NEXT_BATCH_SECONDS } from '@/lib/data';
import { clock } from '@/lib/format';

/**
 * Countdown to the next batch close.
 *
 * The only genuinely live value in the interface, so it is the one place that
 * needs care: state starts at the same fixed number the server rendered, and
 * only starts moving inside an effect, which never runs during SSR. Seeding
 * this from Date.now() instead would make the server and client disagree on the
 * very first paint — the classic hydration mismatch.
 */
export function NextBatch() {
  const [seconds, setSeconds] = useState(NEXT_BATCH_SECONDS);

  useEffect(() => {
    const id = setInterval(() => {
      setSeconds((s) => (s <= 0 ? NEXT_BATCH_SECONDS : s - 1));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <p className="flex items-center gap-2 font-mono text-xs text-muted">
      <span className="size-1.5 rounded-full bg-accent" aria-hidden />
      Next batch in <span className="tnum text-accent">{clock(seconds)}</span>
    </p>
  );
}
