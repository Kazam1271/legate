'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Fades and slides content in the moment it scrolls into view — modelled on
 * how horizenlabs.io/vela reveals its own sections (a translate + opacity
 * transition, eased with cubic-bezier(0.22,1,0.36,1), staggered per item by
 * delaying each one a little further than the last).
 *
 * Hydration-safe the same way CountUp is: children render in their final,
 * visible position on the server and on the client's first paint — nothing
 * here depends on script for content to exist or be readable. Only inside a
 * useEffect, which never runs during SSR, does the element opt into a
 * hidden-then-reveal treatment, armed by an IntersectionObserver that fires
 * once. A visitor without JS, or one who never scrolls this far, sees the
 * content immediately; this only governs how it arrives for everyone else.
 */
export function Reveal({
  children,
  direction = 'up',
  delayMs = 0,
  className = '',
}: {
  children: React.ReactNode;
  direction?: 'up' | 'right';
  delayMs?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;

    setArmed(true);

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setShown(true);
        observer.disconnect();
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const hidden = armed && !shown;
  const offset = direction === 'right' ? 'translate-x-12' : 'translate-y-6';

  return (
    <div
      ref={ref}
      style={{ transitionDelay: hidden ? '0ms' : delayMs + 'ms' }}
      className={
        'transition-[opacity,transform] duration-[1100ms] ease-[cubic-bezier(0.22,1,0.36,1)] ' +
        (hidden ? 'opacity-0 ' + offset : 'translate-x-0 translate-y-0 opacity-100') +
        (className ? ' ' + className : '')
      }
    >
      {children}
    </div>
  );
}
