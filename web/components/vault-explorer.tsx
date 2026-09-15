'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { Sparkline } from '@/components/sparkline';
import { Badge, Card, Delta, LockIcon, PrivateBadge, TokenPill } from '@/components/ui';
import type { Strategy } from '@/lib/data';
import { num, pct, shortAddress, usd, usdCompact } from '@/lib/format';

const SORTS = [
  { key: 'performance', label: 'Performance' },
  { key: 'tvl', label: 'TVL' },
  { key: 'drawdown', label: 'Drawdown' },
] as const;

type SortKey = (typeof SORTS)[number]['key'];

function DepositDialog({ strategy, onClose }: { strategy: Strategy; onClose: () => void }) {
  const [amount, setAmount] = useState('');

  const parsed = Number(amount);
  const shares = Number.isFinite(parsed) && parsed > 0 ? parsed / strategy.nav : 0;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={'Deposit into ' + strategy.name}
      onClick={onClose}
    >
      <Card className="w-full max-w-md p-6 shadow-2xl">
        {/* Clicks inside the panel must not reach the backdrop's close handler. */}
        <div onClick={(e) => e.stopPropagation()}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">Allocate capital</p>
              <h2 className="mt-2 text-xl font-semibold">{strategy.name}</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1 text-faint transition-colors hover:text-fg"
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
                <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <label className="mt-6 block">
            <span className="text-xs text-muted">Amount</span>
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 focus-within:border-accent">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                inputMode="decimal"
                placeholder="0.00"
                className="tnum w-full bg-transparent py-3 font-mono text-lg outline-none placeholder:text-faint"
              />
              <span className="font-mono text-sm text-muted">USDC</span>
            </div>
          </label>

          <dl className="mt-4 space-y-2 rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs">
            <div className="flex justify-between">
              <dt className="text-faint">NAV per share</dt>
              <dd className="tnum text-muted">{usd(strategy.nav)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-faint">estimated shares</dt>
              <dd className="tnum text-fg">{shares > 0 ? num(shares, 4) : '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-faint">fees</dt>
              <dd className="text-muted">
                {num(strategy.managementFeePct, 1)}% mgmt / {num(strategy.performanceFeePct, 0)}% perf
              </dd>
            </div>
          </dl>

          <p className="mt-4 flex gap-2.5 rounded-lg border border-private/25 bg-private/[0.06] p-3 text-[12px] leading-relaxed text-muted">
            <span className="mt-0.5 shrink-0 text-private">
              <LockIcon className="size-3.5" />
            </span>
            Which strategy you back stays private — only this deposit&rsquo;s existence is on-chain.
          </p>

          <button
            type="button"
            disabled={shares <= 0}
            className="mt-5 w-full rounded-lg bg-accent py-3 text-sm font-semibold text-[#1a1206] transition-colors hover:bg-accent-bright disabled:cursor-not-allowed disabled:bg-raised disabled:text-faint"
          >
            {shares > 0 ? 'Review deposit' : 'Enter an amount'}
          </button>
          <p className="mt-3 text-center text-[11px] text-faint">
            Interface preview — no transaction is submitted.
          </p>
        </div>
      </Card>
    </div>
  );
}

function StrategyCard({ strategy, onDeposit }: { strategy: Strategy; onDeposit: () => void }) {
  const positive = strategy.returnPct >= 0;

  return (
    <Card as="li" className="flex flex-col p-5 transition-colors hover:border-line-strong">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={'/vaults/' + strategy.id} className="text-[15px] font-semibold hover:text-accent">
            {strategy.name}
          </Link>
          <p className="mt-1 font-mono text-[11px] text-faint">
            Manager {shortAddress(strategy.manager)}
          </p>
        </div>
        <PrivateBadge />
      </div>

      <div className="mt-5 flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Current NAV</p>
          <p className="tnum mt-1.5 font-mono text-[26px] leading-none">{usd(strategy.nav)}</p>
        </div>
        <div className="shrink-0 text-right">
          <Sparkline series={strategy.navHistory} positive={positive} />
          <Delta value={strategy.returnPct} className="mt-1 block text-sm" />
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-line pt-4 font-mono text-[11px]">
        <div>
          <dt className="text-faint">TVL</dt>
          <dd className="tnum mt-1 text-muted">{usdCompact(strategy.tvl)}</dd>
        </div>
        <div>
          <dt className="text-faint">Max DD</dt>
          <dd className="tnum mt-1 text-muted">{pct(strategy.drawdownPct)}</dd>
        </div>
        <div>
          <dt className="text-faint">Depositors</dt>
          <dd className="tnum mt-1 text-muted">{num(strategy.depositors, 0)}</dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {strategy.mandate.tokens.map((t) => (
          <TokenPill key={t} symbol={t} />
        ))}
        <span className="ml-auto font-mono text-[10px] text-faint">
          {num(strategy.managementFeePct, 1)}% mgmt / {num(strategy.performanceFeePct, 0)}% perf
        </span>
      </div>

      <div className="mt-5 flex gap-2">
        <button
          type="button"
          onClick={onDeposit}
          className="flex-1 rounded-lg bg-accent py-2.5 text-sm font-semibold text-[#1a1206] transition-colors hover:bg-accent-bright"
        >
          Deposit
        </button>
        <Link
          href={'/vaults/' + strategy.id}
          className="rounded-lg border border-line px-4 py-2.5 text-sm text-muted transition-colors hover:border-line-strong hover:text-fg"
        >
          Details
        </Link>
      </div>
    </Card>
  );
}

export function VaultExplorer({ strategies }: { strategies: Strategy[] }) {
  const [sort, setSort] = useState<SortKey>('performance');
  const [token, setToken] = useState<string>('all');
  const [depositing, setDepositing] = useState<Strategy | null>(null);

  const tokens = useMemo(() => {
    const set = new Set<string>();
    strategies.forEach((s) => s.mandate.tokens.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [strategies]);

  const visible = useMemo(() => {
    const filtered =
      token === 'all' ? strategies : strategies.filter((s) => s.mandate.tokens.includes(token));

    return [...filtered].sort((a, b) => {
      if (sort === 'tvl') return b.tvl - a.tvl;
      if (sort === 'drawdown') return a.drawdownPct - b.drawdownPct;
      return b.returnPct - a.returnPct;
    });
  }, [strategies, sort, token]);

  return (
    <>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-b border-line pb-5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Sort by</span>
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSort(s.key)}
              aria-pressed={sort === s.key}
              className={
                'rounded-md px-3 py-1.5 text-xs transition-colors ' +
                (sort === s.key ? 'bg-accent/15 text-accent' : 'text-muted hover:text-fg')
              }
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Token</span>
          <button
            type="button"
            onClick={() => setToken('all')}
            aria-pressed={token === 'all'}
            className={
              'rounded-md px-3 py-1.5 text-xs transition-colors ' +
              (token === 'all' ? 'bg-raised text-fg' : 'text-muted hover:text-fg')
            }
          >
            All
          </button>
          {tokens.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setToken(t)}
              aria-pressed={token === t}
              className={
                'rounded-md px-3 py-1.5 font-mono text-xs transition-colors ' +
                (token === t ? 'bg-raised text-fg' : 'text-muted hover:text-fg')
              }
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <ul className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {visible.map((s) => (
          <StrategyCard key={s.id} strategy={s} onDeposit={() => setDepositing(s)} />
        ))}
      </ul>

      {visible.length === 0 ? (
        <p className="mt-16 text-center text-sm text-faint">No strategy accepts that token yet.</p>
      ) : null}

      <div className="mt-10 flex flex-wrap items-center gap-2 text-xs text-faint">
        <Badge tone="private">
          <LockIcon />
          What you cannot see here
        </Badge>
        Open positions, trade history, and current holdings are never published — for any strategy,
        to anyone.
      </div>

      {depositing ? <DepositDialog strategy={depositing} onClose={() => setDepositing(null)} /> : null}
    </>
  );
}
