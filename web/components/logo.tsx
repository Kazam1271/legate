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
  /**
   * A middle tier between `compact` and full detail: brings back the plain
   * rings and the corner accents, but keeps the multi-tick engravings
   * (the beaded outer ring, the milled edge, the radial hatching) off —
   * those are exactly the elements that resolve to fuzz once a size is small
   * enough to want `compact` in the first place, just less small than 30px.
   * For a spot that wants more presence than compact without going all the
   * way to backdrop-level detail.
   */
  medium?: boolean;
  className?: string;
  title?: string;
}

export function LegateMark({
  size = 32,
  animated = false,
  compact = false,
  medium = false,
  className = '',
  title,
}: MarkProps) {
  const isFull = !compact && !medium;
  const showRings = !compact; // medium and full both keep the plain rings
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

      {isFull ? (
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
      ) : null}

      {/* The milled edge. Seventy-odd ticks resolve to fuzz below about
          100px, so anything short of full detail gets a plain band instead —
          same silhouette, none of the crawling. */}
      <circle
        className="legate-dial"
        cx="100"
        cy="100"
        r="87"
        fill="none"
        stroke="#e0a83d"
        strokeWidth={isFull ? 7 : 2.4}
        strokeDasharray={isFull ? '1.1 6.5' : undefined}
      />

      {showRings ? (
        <circle cx="100" cy="100" r="81.5" fill="none" stroke="#e0a83d" strokeWidth="1.3" />
      ) : null}

      {/* Public half. */}
      <path
        d="M100 24 A76 76 0 0 1 100 176"
        fill="none"
        stroke="#e0a83d"
        strokeWidth={isFull ? 2 : 3}
      />
      {/* Private half. */}
      <path
        d="M100 24 A76 76 0 0 0 100 176"
        fill="none"
        stroke="#a78bfa"
        strokeWidth={isFull ? 2 : 3}
      />

      {showRings ? (
        <circle
          cx="100"
          cy="100"
          r="70.5"
          fill="none"
          stroke="#6b5220"
          strokeWidth="0.5"
          strokeDasharray="3 4"
        />
      ) : null}
      <circle cx="100" cy="100" r="67" fill="#121215" stroke="#8a6a26" strokeWidth="0.5" />

      {isFull ? (
        <circle
          cx="100"
          cy="100"
          r="61"
          fill="none"
          stroke="#6b5220"
          strokeWidth="12"
          strokeDasharray="0.9 7.1"
        />
      ) : null}

      {showRings ? (
        <circle cx="100" cy="100" r="55" fill="none" stroke="#8a6a26" strokeWidth="0.55" />
      ) : null}

      {/* The enclave, shut. Counter-rotates against the dial, and opens a notch
          on hover — the only interaction the mark permits. */}
      <g
        className="legate-aperture"
        fill="#17171b"
        stroke="#b8862c"
        strokeWidth={isFull ? 0.8 : compact ? 1.6 : 1.2}
        strokeLinejoin="round"
      >
        {BLADE_ANGLES.map((angle) => (
          <path key={angle} d={BLADE} transform={'rotate(' + angle + ' 100 100)'} />
        ))}
      </g>

      <circle cx="100" cy="100" r="25" fill="none" stroke="#8a6a26" strokeWidth="0.55" />
      {isFull ? (
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
      ) : null}

      {showRings ? (
        <g fill="#c98f2e">
          <path d="M167.88 25.12 L174.88 32.12 L167.88 39.12 L160.88 32.12 Z" />
          <path d="M32.12 25.12 L39.12 32.12 L32.12 39.12 L25.12 32.12 Z" />
        </g>
      ) : null}

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
      <LegateMark size={44} animated medium title="Legate" className="sm:hidden" />
      <LegateMark size={68} animated medium title="Legate" className="hidden sm:block" />
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
      className="legate-backdrop pointer-events-none fixed top-1/2 right-[-150px] z-[-10] -translate-y-1/2 opacity-[0.07] sm:right-[-230px] lg:right-[-380px] xl:right-[-440px]"
    >
      {/* Each size shows in exactly one range; the parent's right offset is
          always -size/2, so precisely half the mark sits past the edge at
          every breakpoint — the "half wheel" reads the same at every size,
          not just on desktop. */}
      <LegateMark size={300} className="legate-roll block sm:hidden" />
      <LegateMark size={460} className="legate-roll hidden sm:block lg:hidden" />
      <LegateMark size={760} className="legate-roll hidden lg:block xl:hidden" />
      <LegateMark size={880} className="legate-roll hidden xl:block" />
    </div>
  );
}
