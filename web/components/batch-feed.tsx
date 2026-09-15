'use client';

import { useState } from 'react';

import { Badge, LockIcon, SideTag } from '@/components/ui';
import { EPOCH, type Batch, batchVolume, crossedVolume, nettingRatio } from '@/lib/data';
import { amount, num, ratioPct, since, usdCompact, utcTime } from '@/lib/format';

/** Crossed vs residual, as one bar. The gold sliver is all the market saw. */
function NettingBar({ ratio }: { ratio: number }) {
  const crossed = Math.round(ratio * 1000) / 10;
  return (
    <span className="flex items-center gap-2.5">
      <span
        className="flex h-1.5 w-28 overflow-hidden rounded-full bg-raised sm:w-40"
        role="img"
        aria-label={crossed + '% netted inside the enclave'}
      >
        <span className="h-full bg-private/70" style={{ width: crossed + '%' }} />
        <span className="h-full flex-1 bg-accent" />
      </span>
      <span className="tnum w-12 text-right font-mono text-xs text-muted">{ratioPct(ratio)}</span>
    </span>
  );
}

function BatchRow({ batch }: { batch: Batch }) {
  const [open, setOpen] = useState(false);
  const ratio = nettingRatio(batch);
  const internalised = batch.residualBase === 0;

  return (
    <li className="border-b border-line last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="grid w-full grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 px-4 py-3.5 text-left transition-colors hover:bg-surface-2 sm:grid-cols-[88px_120px_minmax(0,1fr)_auto] sm:gap-x-5"
      >
        <span className="font-mono text-xs text-accent">{batch.id}</span>

        <span className="tnum hidden font-mono text-xs text-faint sm:block">
          {utcTime(batch.timestamp)}
        </span>

        <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
          {internalised ? (
            <Badge tone="private">
              <LockIcon />
              Fully private — nothing reached the chain
            </Badge>
          ) : (
            <span className="flex items-center gap-2">
              <SideTag side={batch.residualSide} />
              <span className="tnum font-mono text-sm text-fg">
                {amount(batch.residualBase)} <span className="text-muted">{batch.base}</span>
              </span>
            </span>
          )}
          <span className="tnum font-mono text-xs text-faint">@ {num(batch.clearingPrice)}</span>
        </span>

        <span className="col-span-2 flex items-center justify-between gap-3 sm:col-span-1 sm:justify-end">
          <NettingBar ratio={ratio} />
          <span
            className={'text-faint transition-transform ' + (open ? 'rotate-90' : '')}
            aria-hidden
          >
            &rsaquo;
          </span>
        </span>
      </button>

      {open ? (
        <div className="border-t border-line bg-surface-2/60 px-4 py-4">
          <dl className="grid gap-x-8 gap-y-3 font-mono text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex justify-between gap-3">
              <dt className="text-faint">pair</dt>
              <dd className="text-muted">
                {batch.base}/{batch.quote}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-faint">clearing price</dt>
              <dd className="tnum text-muted">{num(batch.clearingPrice)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-faint">crossed internally</dt>
              <dd className="tnum text-private">
                {amount(batch.crossedBase)} {batch.base}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-faint">residual to market</dt>
              <dd className="tnum text-accent">
                {internalised ? '—' : amount(batch.residualBase) + ' ' + batch.base}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-faint">batch volume</dt>
              <dd className="tnum text-muted">{usdCompact(batchVolume(batch))}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-faint">never touched market</dt>
              <dd className="tnum text-private">{usdCompact(crossedVolume(batch))}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-faint">contributors</dt>
              <dd className="tnum text-muted">{batch.contributors} strategies</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-faint">settled</dt>
              <dd className="text-muted">{since(batch.timestamp, EPOCH)}</dd>
            </div>
          </dl>

          <p className="mt-4 max-w-3xl text-[11px] leading-relaxed text-faint">
            {batch.contributors} strategies contributed intents to this batch. Which of them was on
            which side, and in what size, is not recoverable from any of the figures above — many
            different sets of intents net to the same residual.
          </p>
        </div>
      ) : null}
    </li>
  );
}

export function BatchFeed({ batches }: { batches: Batch[] }) {
  return (
    <ul className="divide-y-0">
      {batches.map((b) => (
        <BatchRow key={b.id} batch={b} />
      ))}
    </ul>
  );
}
