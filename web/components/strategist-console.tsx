'use client';

import { useMemo, useState } from 'react';

import { NextBatch } from '@/components/next-batch';
import { Badge, Card, LockIcon, Row, SideTag, TokenPill } from '@/components/ui';
import type { Fill, QueuedIntent, Side, Strategy } from '@/lib/data';
import { amount, num, shortAddress, usd, utcTime } from '@/lib/format';

interface ConsoleProps {
  strategies: Strategy[];
  fills: Record<string, Fill[]>;
  queued: Record<string, QueuedIntent[]>;
}

function IntentForm({ strategy }: { strategy: Strategy }) {
  const [side, setSide] = useState<Side>('buy');
  const [token, setToken] = useState(strategy.mandate.baseSymbol);
  const [size, setSize] = useState('');
  const [limit, setLimit] = useState('');

  // A buy without a bound would let the enclave spend whatever the venue asks.
  // A sell needs no bound, so the field is optional and reads as "Market".
  const limitRequired = side === 'buy';
  const parsedSize = Number(size);
  const overMandate = Number.isFinite(parsedSize) && parsedSize > strategy.mandate.maxOrderSize;
  const ready =
    Number.isFinite(parsedSize) && parsedSize > 0 && !overMandate && (!limitRequired || Number(limit) > 0);

  const tradeableTokens = strategy.mandate.tokens.filter((t) => t !== 'USDC');

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">Encrypted order</p>
          <h2 className="mt-2 text-xl font-semibold">New intent</h2>
        </div>
        <Badge tone="private">
          <LockIcon />
          Encrypted end-to-end
        </Badge>
      </div>

      <div className="mt-6 grid grid-cols-2 overflow-hidden rounded-lg border border-line" role="group" aria-label="Side">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            aria-pressed={side === s}
            className={
              'py-3 text-sm font-medium capitalize transition-colors ' +
              (side === s
                ? s === 'buy'
                  ? 'bg-positive/12 text-positive'
                  : 'bg-negative/12 text-negative'
                : 'text-muted hover:text-fg')
            }
          >
            <span aria-hidden>{s === 'buy' ? '↑ ' : '↓ '}</span>
            {s}
          </button>
        ))}
      </div>

      <label className="mt-5 block">
        <span className="text-xs text-muted">Base token</span>
        <select
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="mt-2 w-full appearance-none rounded-lg border border-line bg-surface-2 px-3 py-3 font-mono text-sm outline-none transition-colors focus:border-accent"
        >
          {tradeableTokens.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="flex items-baseline justify-between">
            <span className="text-xs text-muted">Amount</span>
            <span className="font-mono text-[10px] text-faint">
              max {num(strategy.mandate.maxOrderSize, 0)}
            </span>
          </span>
          <input
            value={size}
            onChange={(e) => setSize(e.target.value.replace(/[^0-9.]/g, ''))}
            inputMode="decimal"
            placeholder="0.00"
            aria-invalid={overMandate}
            className={
              'tnum mt-2 w-full rounded-lg border bg-surface-2 px-3 py-3 font-mono text-sm outline-none transition-colors placeholder:text-faint ' +
              (overMandate ? 'border-negative' : 'border-line focus:border-accent')
            }
          />
        </label>

        <label className="block">
          <span className="flex items-baseline justify-between">
            <span className="text-xs text-muted">Limit price</span>
            {limitRequired ? (
              <span className="font-mono text-[10px] text-accent">Required</span>
            ) : (
              <span className="font-mono text-[10px] text-faint">Optional</span>
            )}
          </span>
          <input
            value={limit}
            onChange={(e) => setLimit(e.target.value.replace(/[^0-9.]/g, ''))}
            inputMode="decimal"
            required={limitRequired}
            placeholder={limitRequired ? '3,200.00' : 'Market'}
            title={
              limitRequired
                ? 'Buys need a limit price — it is what bounds the cost the enclave will accept on your behalf.'
                : 'Sells execute at the batch clearing price.'
            }
            className="tnum mt-2 w-full rounded-lg border border-line bg-surface-2 px-3 py-3 font-mono text-sm outline-none transition-colors placeholder:text-faint focus:border-accent"
          />
        </label>
      </div>

      {limitRequired ? (
        <p className="mt-2.5 text-[11px] leading-relaxed text-faint">
          Buys need a limit price — it is what bounds the cost the enclave will accept on your behalf.
        </p>
      ) : null}

      {overMandate ? (
        <p className="mt-3 rounded-lg border border-negative/30 bg-negative/[0.07] px-3 py-2.5 text-[12px] text-negative">
          Over this strategy&rsquo;s mandate. The enclave would refuse this intent — privately, so
          nobody else would learn it was attempted.
        </p>
      ) : null}

      <p className="mt-5 flex gap-2.5 rounded-lg border border-accent/25 bg-accent/[0.06] p-3.5 text-[12px] leading-relaxed">
        <span className="mt-0.5 shrink-0 text-accent">
          <LockIcon className="size-3.5" />
        </span>
        <span>
          <strong className="font-semibold text-accent">Encrypted before it leaves your browser.</strong>
          <span className="text-muted"> No one — including Legate — sees this intent until it is netted.</span>
        </span>
      </p>

      <button
        type="button"
        disabled={!ready}
        className="mt-5 w-full rounded-lg bg-accent py-3 text-sm font-semibold text-[#1a1206] transition-colors hover:bg-accent-bright disabled:cursor-not-allowed disabled:bg-raised disabled:text-faint"
      >
        {ready ? 'Encrypt and submit intent' : 'Complete the order'}
      </button>
      <p className="mt-3 text-center text-[11px] text-faint">
        Interface preview — no request is submitted.
      </p>
    </Card>
  );
}

function FillsTable({ fills }: { fills: Fill[] }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-5">
        <div>
          <h2 className="text-sm font-semibold">Your private fills</h2>
          <p className="mt-1.5 text-[12px] text-muted">
            What each intent actually settled at, visible in this authenticated view only.
          </p>
        </div>
        <Badge tone="private">
          <LockIcon />
          Only you can see this
        </Badge>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[540px] text-sm">
          <thead>
            <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
              <th className="px-5 py-3 font-normal">Batch</th>
              <th className="px-5 py-3 font-normal">Time</th>
              <th className="px-5 py-3 font-normal">Side</th>
              <th className="px-5 py-3 text-right font-normal">Amount</th>
              <th className="px-5 py-3 text-right font-normal">Settled at</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {fills.map((f) => (
              <tr key={f.batchId + f.side} className="transition-colors hover:bg-surface-2">
                <td className="px-5 py-3 font-mono text-xs text-accent">{f.batchId}</td>
                <td className="tnum px-5 py-3 font-mono text-xs text-faint">{utcTime(f.timestamp)}</td>
                <td className="px-5 py-3">
                  <SideTag side={f.side} />
                </td>
                <td className="tnum px-5 py-3 text-right font-mono text-xs text-fg">
                  {amount(f.amount)} <span className="text-muted">{f.base}</span>
                </td>
                <td className="px-5 py-3 text-right">
                  {f.filled ? (
                    <span className="tnum font-mono text-xs text-muted">{usd(f.price)}</span>
                  ) : (
                    <span
                      className="font-mono text-[11px] text-faint"
                      title="The residual leg did not execute. Volume that crossed internally still settled."
                    >
                      crossed only
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function StrategistConsole({ strategies, fills, queued }: ConsoleProps) {
  const [selectedId, setSelectedId] = useState(strategies[0].id);

  const selected = useMemo(
    () => strategies.find((s) => s.id === selectedId) ?? strategies[0],
    [strategies, selectedId],
  );

  const myFills = fills[selected.id] ?? [];
  const myQueue = queued[selected.id] ?? [];

  return (
    <>
      {/* Strategy switcher */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold">Your strategies</h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {strategies.map((s) => {
            const active = s.id === selected.id;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(s.id)}
                  aria-pressed={active}
                  className={
                    'flex w-full items-center justify-between gap-3 rounded-[10px] border px-4 py-3.5 text-left transition-colors ' +
                    (active
                      ? 'border-accent/45 bg-accent/[0.07]'
                      : 'border-line bg-surface hover:border-line-strong')
                  }
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span
                        className={'size-1.5 shrink-0 rounded-full ' + (active ? 'bg-accent' : 'bg-line-strong')}
                        aria-hidden
                      />
                      <span className="truncate text-sm font-medium">{s.name}</span>
                    </span>
                    <span className="mt-1 block pl-3.5 font-mono text-[11px] text-faint">
                      {shortAddress(s.manager)}
                    </span>
                  </span>
                  <span className="shrink-0 text-faint" aria-hidden>
                    &rsaquo;
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="mt-10 border-t border-line pt-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
            {selected.name} / manager view
          </p>
          <NextBatch />
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-6">
            <IntentForm key={selected.id} strategy={selected} />
            {myFills.length > 0 ? <FillsTable fills={myFills} /> : null}
          </div>

          <aside className="space-y-6">
            <Card className="p-5">
              <h2 className="text-sm font-semibold">Mandate</h2>
              <p className="mt-2 text-[12px] leading-relaxed text-muted">
                Set at registration and enforced by the enclave. Read-only here.
              </p>
              <div className="mt-4 divide-y divide-line border-t border-line">
                <div className="flex items-center justify-between gap-4 py-3">
                  <span className="font-mono text-xs text-faint">tokens</span>
                  <span className="flex flex-wrap justify-end gap-1.5">
                    {selected.mandate.tokens.map((t) => (
                      <TokenPill key={t} symbol={t} />
                    ))}
                  </span>
                </div>
                <Row
                  label="max order"
                  value={num(selected.mandate.maxOrderSize, 0) + ' ' + selected.mandate.baseSymbol}
                  tone="muted"
                />
                <Row
                  label="max position"
                  value={num(selected.mandate.maxPositionSize, 0) + ' ' + selected.mandate.baseSymbol}
                  tone="muted"
                />
              </div>
            </Card>

            <Card className="p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">Queued</h2>
                <span className="font-mono text-[11px] text-faint">
                  {myQueue.length} awaiting close
                </span>
              </div>

              {myQueue.length === 0 ? (
                <p className="mt-4 text-[12px] text-faint">
                  Nothing queued. Intents wait here until the next batch closes.
                </p>
              ) : (
                <ul className="mt-4 space-y-2.5">
                  {myQueue.map((i) => (
                    <li
                      key={i.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5"
                    >
                      <span className="min-w-0">
                        <SideTag side={i.side} />
                        <span className="tnum ml-2 font-mono text-xs text-fg">
                          {amount(i.amount)} {i.base}
                        </span>
                      </span>
                      <span className="tnum shrink-0 font-mono text-[11px] text-faint">
                        {i.limitPrice ? '≤ ' + num(i.limitPrice) : 'market'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-4 flex gap-2.5 text-[11px] leading-relaxed text-faint">
                <span className="mt-0.5 shrink-0 text-private">
                  <LockIcon className="size-3.5" />
                </span>
                Queued intents are held encrypted. They become a single pooled order only after
                netting.
              </p>
            </Card>
          </aside>
        </div>
      </div>
    </>
  );
}
