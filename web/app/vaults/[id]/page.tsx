import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { SealBackdrop } from '@/components/logo';
import { NavChart } from '@/components/nav-chart';
import { Badge, Card, Delta, Eyebrow, LockIcon, PrivateBadge, Row, SideTag, TokenPill } from '@/components/ui';
import { EPOCH, batchesFor, nettingRatio, strategyById, STRATEGIES } from '@/lib/data';
import { amount, num, pct, ratioPct, shortAddress, usd, usdCompact, utcDate } from '@/lib/format';

interface PageProps {
  params: Promise<{ id: string }>;
}

export function generateStaticParams() {
  return STRATEGIES.map((s) => ({ id: s.id }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const strategy = strategyById(id);
  return {
    title: strategy ? strategy.name : 'Strategy',
    description: strategy
      ? strategy.name + ' — attested NAV and enclave-enforced mandate. Positions stay private.'
      : undefined,
  };
}

export default async function StrategyPage({ params }: PageProps) {
  const { id } = await params;
  const strategy = strategyById(id);
  if (!strategy) notFound();

  const batches = batchesFor(strategy.id);
  const { mandate } = strategy;

  return (
    <>
      <SealBackdrop />
      <div className="relative z-10 mx-auto max-w-[1240px] px-5 py-14 sm:px-8">
      <Link href="/vaults" className="font-mono text-xs text-faint transition-colors hover:text-muted">
        &larr; All vaults
      </Link>

      <header className="mt-6 flex flex-col gap-6 border-b border-line pb-8 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <Eyebrow>Strategy</Eyebrow>
          <h1 className="mt-3 text-[34px] font-semibold tracking-[-0.025em] sm:text-[40px]">
            {strategy.name}
          </h1>
          <p className="mt-2 font-mono text-xs text-faint">Manager {shortAddress(strategy.manager, 10, 6)}</p>
        </div>

        <div className="flex gap-10">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">NAV / share</p>
            <p className="tnum mt-1.5 font-mono text-[30px] leading-none">{usd(strategy.nav)}</p>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Since inception</p>
            <Delta value={strategy.returnPct} className="mt-1.5 block text-[30px] leading-none" />
          </div>
        </div>
      </header>

      <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* min-w-0: without it, a grid item won't shrink below its content's
            intrinsic width — and the batch-participation table's min-w-[520px]
            would then inflate this whole column, and the page along with it,
            instead of scrolling inside its own overflow-x-auto wrapper. */}
        <div className="min-w-0 space-y-6">
          <Card className="p-5 sm:p-6">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Net asset value</h2>
              <PrivateBadge label="Attested" detail="NAV is attested by the enclave. The holdings behind it are not published." />
            </div>
            <NavChart series={strategy.navHistory} endsAt={EPOCH} />
          </Card>

          {/* Batch participation — public facts only. */}
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-5">
              <div>
                <h2 className="text-sm font-semibold">Batch participation</h2>
                <p className="mt-1.5 max-w-xl text-[12px] leading-relaxed text-muted">
                  Batches this strategy took part in, showing only what the batch made public. Its
                  own side, size, and fill in each one stay private — this table cannot reveal them.
                </p>
              </div>
              <Badge tone="private">
                <LockIcon />
                Public batch facts only
              </Badge>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                    <th className="px-5 py-3 font-normal">Batch</th>
                    <th className="px-5 py-3 font-normal">Date</th>
                    <th className="px-5 py-3 font-normal">Residual</th>
                    <th className="px-5 py-3 text-right font-normal">Clearing</th>
                    <th className="px-5 py-3 text-right font-normal">Netted</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {batches.map((b) => (
                    <tr key={b.id} className="transition-colors hover:bg-surface-2">
                      <td className="px-5 py-3 font-mono text-xs text-accent">{b.id}</td>
                      <td className="px-5 py-3 font-mono text-xs text-muted">{utcDate(b.timestamp)}</td>
                      <td className="px-5 py-3">
                        {b.residualBase === 0 ? (
                          <span className="font-mono text-xs text-faint">— fully internalised</span>
                        ) : (
                          <span className="flex items-center gap-2">
                            <SideTag side={b.residualSide} />
                            <span className="tnum font-mono text-xs text-muted">
                              {amount(b.residualBase)} {b.base}
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="tnum px-5 py-3 text-right font-mono text-xs text-muted">
                        {num(b.clearingPrice)}
                      </td>
                      <td className="tnum px-5 py-3 text-right font-mono text-xs text-accent">
                        {ratioPct(nettingRatio(b))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <aside className="space-y-6">
          {/* Mandate: the guarantee that makes a private strategy investable. */}
          <Card className="p-5">
            <h2 className="text-sm font-semibold">Mandate</h2>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
              Enforced by the enclave on every intent, not by the strategist&rsquo;s own code. An
              order outside these bounds is refused before it can be netted.
            </p>

            <div className="mt-4 divide-y divide-line border-t border-line">
              <div className="flex items-center justify-between gap-4 py-3">
                <span className="font-mono text-xs text-faint">allowed tokens</span>
                <span className="flex flex-wrap justify-end gap-1.5">
                  {mandate.tokens.map((t) => (
                    <TokenPill key={t} symbol={t} />
                  ))}
                </span>
              </div>
              <Row label="max order size" value={num(mandate.maxOrderSize, 0) + ' ' + mandate.baseSymbol} tone="muted" />
              <Row label="max position" value={num(mandate.maxPositionSize, 0) + ' ' + mandate.baseSymbol} tone="muted" />
              <Row label="max drawdown seen" value={pct(strategy.drawdownPct)} tone="muted" />
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-semibold">Your position</h2>

            <div className="mt-4 divide-y divide-line border-t border-line">
              <Row label="shares" value="0.0000" tone="muted" />
              <Row label="value" value={usd(0)} tone="muted" />
              <Row
                label="fees"
                value={num(strategy.managementFeePct, 1) + '% / ' + num(strategy.performanceFeePct, 0) + '%'}
                tone="muted"
              />
            </div>

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-lg bg-accent py-2.5 text-sm font-semibold text-[#1a1206] transition-colors hover:bg-accent-bright"
              >
                Deposit
              </button>
              <button
                type="button"
                disabled
                className="flex-1 rounded-lg border border-line py-2.5 text-sm text-faint disabled:cursor-not-allowed"
              >
                Withdraw
              </button>
            </div>

            <p className="mt-4 flex gap-2.5 text-[11px] leading-relaxed text-faint">
              <span className="mt-0.5 shrink-0 text-private">
                <LockIcon className="size-3.5" />
              </span>
              Which strategy you back stays private — only the deposit&rsquo;s existence is on-chain.
            </p>
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-semibold">Vault</h2>
            <div className="mt-4 divide-y divide-line border-t border-line">
              <Row label="total value" value={usdCompact(strategy.tvl)} tone="muted" />
              <Row label="depositors" value={num(strategy.depositors, 0)} tone="muted" />
              <Row label="track record" value={strategy.inceptionDays + ' days'} tone="muted" />
            </div>
          </Card>
        </aside>
      </div>
      </div>
    </>
  );
}
