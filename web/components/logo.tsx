/**
 * The Legate seal.
 *
 * One emblem, drawn once in a 200-unit square so it scales cleanly from a
 * favicon to a page-sized backdrop. The geometry is load-bearing, not
 * decorative:
 *
 *   - the ring is violet on the left and gold on the right — private side,
 *     public side, one object;
 *   - three violet strokes enter from the left: encrypted intents, unreadable
 *     by anyone including us;
 *   - the six-bladed aperture is the enclave, shut;
 *   - a single gold ray leaves the centre and crosses the milled edge. Many
 *     intents in, one netted order out.
 *
 * No client state anywhere: motion is CSS only, so this renders identically on
 * the server and in the browser.
 */

const BLADE = 'M100 45 A55 55 0 0 1 147.63 72.5 L121.65 87.5 A25 25 0 0 0 100 75 Z';
const BLADE_ANGLES = [0, 60, 120, 180, 240, 300];

export interface MarkProps {
  size?: number;
  /** Turns the seal into a slow vault dial that opens on hover. */
  animated?: boolean;
  /** Drops the finest engraving, which only muddies things below ~40px. */
  compact?: boolean;
  className?: string;
  title?: string;
}

export function LegateMark({
  size = 32,
  animated = false,
  compact = false,
  className = '',
  title,
}: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      className={(animated ? 'legate-seal ' : '') + className}
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}

      <circle cx="100" cy="100" r="96" fill="none" stroke="#6b5220" strokeWidth="0.7" />

      {compact ? null : (
        <circle
          cx="100"
          cy="100"
          r="92"
          fill="none"
          stroke="#c98f2e"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeDasharray="0.01 6.4"
        />
      )}

      {/* The milled edge, and the reason `compact` exists: seventy-odd ticks
          resolve to fuzz below about 40px, so small sizes get a plain band
          instead. Same silhouette, none of the crawling. */}
      <circle
        className="legate-dial"
        cx="100"
        cy="100"
        r="87"
        fill="none"
        stroke="#e0a83d"
        strokeWidth={compact ? 2.4 : 7}
        strokeDasharray={compact ? undefined : '1.1 6.5'}
      />

      {compact ? null : (
        <circle cx="100" cy="100" r="81.5" fill="none" stroke="#e0a83d" strokeWidth="1.3" />
      )}

      {/* Public half. */}
      <path
        d="M100 24 A76 76 0 0 1 100 176"
        fill="none"
        stroke="#e0a83d"
        strokeWidth={compact ? 3 : 2}
      />
      {/* Private half. */}
      <path
        d="M100 24 A76 76 0 0 0 100 176"
        fill="none"
        stroke="#a78bfa"
        strokeWidth={compact ? 3 : 2}
      />

      {compact ? null : (
        <circle
          cx="100"
          cy="100"
          r="70.5"
          fill="none"
          stroke="#6b5220"
          strokeWidth="0.5"
          strokeDasharray="3 4"
        />
      )}
      <circle cx="100" cy="100" r="67" fill="#121215" stroke="#8a6a26" strokeWidth="0.5" />

      {compact ? null : (
        <circle
          cx="100"
          cy="100"
          r="61"
          fill="none"
          stroke="#6b5220"
          strokeWidth="12"
          strokeDasharray="0.9 7.1"
        />
      )}

      {compact ? null : (
        <circle cx="100" cy="100" r="55" fill="none" stroke="#8a6a26" strokeWidth="0.55" />
      )}

      {/* The enclave, shut. Counter-rotates against the dial, and opens a notch
          on hover — the only interaction the mark permits. */}
      <g
        className="legate-aperture"
        fill="#17171b"
        stroke="#b8862c"
        strokeWidth={compact ? 1.6 : 0.8}
        strokeLinejoin="round"
      >
        {BLADE_ANGLES.map((angle) => (
          <path key={angle} d={BLADE} transform={'rotate(' + angle + ' 100 100)'} />
        ))}
      </g>

      <circle cx="100" cy="100" r="25" fill="none" stroke="#8a6a26" strokeWidth="0.55" />
      {compact ? null : (
        <circle
          cx="100"
          cy="100"
          r="28"
          fill="none"
          stroke="#6b5220"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeDasharray="0.01 5.9"
        />
      )}

      {compact ? null : (
        <g fill="#c98f2e">
          <path d="M167.88 25.12 L174.88 32.12 L167.88 39.12 L160.88 32.12 Z" />
          <path d="M32.12 25.12 L39.12 32.12 L32.12 39.12 L25.12 32.12 Z" />
        </g>
      )}

      {/* Encrypted intents arriving. */}
      <g stroke="#a78bfa" strokeWidth="2.4" strokeLinecap="round" fill="none">
        <path d="M81 91 L94 100" />
        <path d="M81 100 L94 100" />
        <path d="M81 109 L94 100" />
      </g>

      {/* Where private becomes public. */}
      <circle cx="96" cy="100" r="5.8" fill="none" stroke="#a78bfa" strokeWidth="1" />
      <circle cx="96" cy="100" r="3.4" fill="#f0bd58" />

      {/* The one netted order, leaving through the edge. */}
      <path
        className="legate-ray"
        d="M96 100 L196 100"
        fill="none"
        stroke="#f0bd58"
        strokeWidth="3.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The seal paired with the wordmark, for the top of the hero — the one place on
 * the page that earns a proper brand statement rather than the compact nav
 * mark. Both lines are real HTML text (not baked into the SVG), so they inherit
 * the site's actual type and stay selectable and readable by screen readers.
 */
export function HeroBrand() {
  return (
    <div className="flex items-center gap-3 sm:gap-4">
      {/* Two sizes, not a CSS scale on one mark: LegateMark sets width/height
          as SVG attributes, not Tailwind classes, so it doesn't shrink with
          its container on its own — same pattern as SealBackdrop. */}
      <LegateMark size={44} animated compact title="Legate" className="sm:hidden" />
      <LegateMark size={68} animated compact title="Legate" className="hidden sm:block" />
      <div className="flex flex-col items-start">
        <p className="font-mono text-lg font-semibold tracking-[0.22em] text-fg sm:text-2xl sm:tracking-[0.34em]">
          LEGATE
        </p>
        <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-faint sm:mt-2 sm:text-xs sm:tracking-[0.22em]">
          Private execution infrastructure
        </p>
      </div>
    </div>
  );
}

/**
 * The seal used as a backdrop: sized past the viewport and anchored so its
 * centre sits on the right edge, leaving only the private half visible. The
 * public half is literally off-screen, which is the joke and also the point.
 *
 * Fixed, so it holds its place while the page scrolls past, and turns slowly on
 * that spot as you go — driven by `animation-timeline: scroll()`, which is a
 * CSS-only scroll binding. No listener, no state, nothing that could disagree
 * with the server render. Browsers without it fall back to a slow idle turn.
 */
export function SealBackdrop() {
  return (
    <div
      aria-hidden
      className="legate-backdrop pointer-events-none fixed top-1/2 right-[-380px] z-[-10] hidden -translate-y-1/2 opacity-[0.07] lg:block xl:right-[-440px]"
    >
      <LegateMark size={760} className="legate-roll xl:hidden" />
      <LegateMark size={880} className="legate-roll hidden xl:block" />
    </div>
  );
}
