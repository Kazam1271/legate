import type { ReactNode } from 'react';

/** Small uppercase label that sits above a heading. */
export function Eyebrow({ children, dot = true }: { children: ReactNode; dot?: boolean }) {
  return (
    <p className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted">
      {dot ? <span className="size-1.5 rounded-full bg-accent" aria-hidden /> : null}
      {children}
    </p>
  );
}

export function Card({
  children,
  className = '',
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'li';
}) {
  return (
    <Tag className={'rounded-[10px] border border-line bg-surface ' + className}>{children}</Tag>
  );
}

type BadgeTone = 'neutral' | 'accent' | 'positive' | 'negative' | 'private';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'border-line-strong text-muted',
  accent: 'border-accent/40 bg-accent/10 text-accent',
  positive: 'border-positive/30 bg-positive/10 text-positive',
  negative: 'border-negative/30 bg-negative/10 text-negative',
  private: 'border-private/30 bg-private/10 text-private',
};

export function Badge({
  children,
  tone = 'neutral',
  title,
  className = '',
}: {
  children: ReactNode;
  tone?: BadgeTone;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ' +
        BADGE_TONES[tone] +
        ' ' +
        className
      }
    >
      {children}
    </span>
  );
}

export function LockIcon({ className = 'size-3' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="4" y="10" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M8 10V7a4 4 0 1 1 8 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function ShieldIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M12 3 5 6v5.5c0 4.2 2.9 8.1 7 9.5 4.1-1.4 7-5.3 7-9.5V6l-7-3Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="m9 12 2.2 2.2L15.5 10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The single most repeated idea in this interface: this figure is real, and the
 * thing behind it still is not visible. Used wherever a number could be
 * mistaken for a window into a strategy.
 */
export function PrivateBadge({ label = 'Positions private', detail }: { label?: string; detail?: string }) {
  return (
    <Badge
      tone="private"
      title={detail ?? 'This strategy’s holdings are never exposed. Only attested NAV is public.'}
    >
      <LockIcon />
      {label}
    </Badge>
  );
}

export function Stat({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">{label}</p>
      <p
        className={
          'tnum mt-2 font-mono text-2xl sm:text-[28px] leading-none ' +
          (accent ? 'text-accent' : 'text-fg')
        }
      >
        {value}
      </p>
      {hint ? <p className="mt-2 text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

/** Key/value row used in the status and mandate panels. */
export function Row({
  label,
  value,
  mono = true,
  tone,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  tone?: 'accent' | 'positive' | 'muted';
}) {
  const toneClass =
    tone === 'accent' ? 'text-accent' : tone === 'positive' ? 'text-positive' : tone === 'muted' ? 'text-muted' : 'text-fg';
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <span className="font-mono text-xs text-faint">{label}</span>
      <span className={'text-sm ' + (mono ? 'tnum font-mono ' : '') + toneClass}>{value}</span>
    </div>
  );
}

export function TokenPill({ symbol }: { symbol: string }) {
  return (
    <span className="rounded border border-line-strong px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-muted">
      {symbol}
    </span>
  );
}

export function Delta({ value, className = '' }: { value: number; className?: string }) {
  const tone = value >= 0 ? 'text-positive' : 'text-negative';
  const sign = value > 0 ? '+' : '';
  return (
    <span className={'tnum font-mono ' + tone + ' ' + className}>
      {sign}
      {value.toFixed(1)}%
    </span>
  );
}

export function SideTag({ side }: { side: 'buy' | 'sell' }) {
  return (
    <span
      className={
        'inline-flex items-center gap-1 font-mono text-xs uppercase tracking-wide ' +
        (side === 'buy' ? 'text-positive' : 'text-negative')
      }
    >
      <span aria-hidden>{side === 'buy' ? '↑' : '↓'}</span>
      {side}
    </span>
  );
}

/** Page-level heading block, shared by every inner page. */
export function PageHeader({
  eyebrow,
  title,
  lede,
  aside,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
  aside?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-6 border-b border-line pb-8 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-3 text-[32px] font-semibold leading-tight tracking-[-0.02em] sm:text-[40px]">{title}</h1>
        {lede ? <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">{lede}</p> : null}
      </div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </header>
  );
}
