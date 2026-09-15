import type { CSSProperties } from 'react';

import { Badge, ShieldIcon } from '@/components/ui';

/**
 * The one idea the whole product rests on, made visible: several private
 * intents go in, one public order comes out, and nothing links them.
 *
 * Deliberately a server component with CSS-only animation. A JS loop would need
 * client state, and state that differs between the server render and the first
 * client render is what produces hydration errors.
 */

interface Intent {
  strategy: string;
  cipher: string;
  travel: number;
  delay: number;
}

// Fixed ciphertext strings: every request is padded to the same size, so equal
// visual length here is accurate, not decorative.
const INTENTS: Intent[] = [
  { strategy: 'Strategy Alpha', cipher: '8f3a91d4c7e0b52a', travel: 26, delay: 0 },
  { strategy: 'Strategy Beta', cipher: 'd1b7e64f0a29c8d3', travel: 26, delay: 0.5 },
  { strategy: 'Strategy Gamma', cipher: '4c0e82b5d9f16a7e', travel: 26, delay: 1 },
  { strategy: 'Strategy Delta', cipher: 'a95d3f18c604e2b7', travel: 26, delay: 1.5 },
];

function EncryptedCard({ intent }: { intent: Intent }) {
  const style = {
    '--travel': intent.travel + 'px',
    animationDelay: intent.delay + 's',
  } as CSSProperties;

  return (
    <li
      style={style}
      className="animate-intent relative overflow-hidden rounded-lg border border-line bg-surface-2 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted">{intent.strategy}</span>
        <span className="text-private" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" className="size-3">
            <rect x="4" y="10" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
            <path d="M8 10V7a4 4 0 1 1 8 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
      </div>

      {/* Blurred, not greyed: the point is that it is unreadable, not disabled. */}
      <p className="mt-2 select-none font-mono text-[13px] text-faint blur-[3px]" aria-hidden>
        {intent.cipher}
      </p>
      <p className="mt-1.5 select-none font-mono text-[10px] uppercase tracking-widest text-faint/70 blur-[2px]" aria-hidden>
        side ?? &nbsp; size ??
      </p>

      <span className="sr-only">Encrypted intent from {intent.strategy}. Contents not visible to anyone.</span>

      {/* Faint scan sweep, so the card reads as "in flight" rather than static. */}
      <span
        className="animate-sweep pointer-events-none absolute inset-y-0 -left-full w-1/3 bg-gradient-to-r from-transparent via-white/[0.04] to-transparent"
        style={{ animationDelay: intent.delay + 's' }}
        aria-hidden
      />
    </li>
  );
}

function ColumnHeading({ children, tone }: { children: React.ReactNode; tone: 'private' | 'accent' }) {
  return (
    <p
      className={
        'mb-4 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] ' +
        (tone === 'private' ? 'text-private' : 'text-accent')
      }
    >
      <span className={'size-1.5 rounded-full ' + (tone === 'private' ? 'bg-private' : 'bg-accent')} aria-hidden />
      {children}
    </p>
  );
}

export function NettingDiagram() {
  return (
    <div className="grid items-center gap-8 lg:grid-cols-[1fr_auto_1fr] lg:gap-6">
      {/* What strategies send */}
      <div>
        <ColumnHeading tone="private">What strategies send</ColumnHeading>
        <ul className="space-y-2.5">
          {INTENTS.map((intent) => (
            <EncryptedCard key={intent.strategy} intent={intent} />
          ))}
        </ul>
      </div>

      {/* The enclave */}
      <div className="flex flex-col items-center gap-3 px-2 py-4 lg:w-[210px]">
        <div className="animate-enclave flex size-16 items-center justify-center rounded-2xl border border-accent/40 bg-accent/[0.07] text-accent">
          <ShieldIcon className="size-7" />
        </div>
        <p className="font-mono text-xs font-medium text-accent">Vela TEE</p>
        <p className="text-center text-[11px] leading-relaxed text-faint">
          Intents netted here.
          <br />
          Never decrypted outside the enclave.
        </p>

        <svg viewBox="0 0 120 12" className="mt-1 hidden w-full text-line-strong lg:block" aria-hidden>
          <path d="M0 6h104" stroke="currentColor" strokeWidth="1" strokeDasharray="3 4" />
          <path d="m104 2 8 4-8 4z" fill="currentColor" />
        </svg>
      </div>

      {/* What the chain sees */}
      <div>
        <ColumnHeading tone="accent">What the chain sees</ColumnHeading>
        <div className="animate-residual rounded-lg border border-line-strong bg-surface-2 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-widest text-faint">Order</p>
              <p className="tnum mt-1.5 font-mono text-xl text-fg">
                Buy 4.0 <span className="text-muted">WETH</span>
              </p>
            </div>
            <Badge tone="accent">
              <svg viewBox="0 0 24 24" fill="none" className="size-3" aria-hidden>
                <path d="m5 13 4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Verified on-chain
            </Badge>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3 font-mono text-[11px]">
            <div className="flex justify-between">
              <dt className="text-faint">clearing</dt>
              <dd className="tnum text-muted">3,184.20</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-faint">venue</dt>
              <dd className="text-muted">public</dd>
            </div>
          </dl>
        </div>

        <p className="mt-4 text-[13px] leading-relaxed text-muted">
          Ten bought, six sold, four reached the market. An observer sees the four and cannot
          tell which strategies produced it, in what size, or on which side.
        </p>
      </div>
    </div>
  );
}
