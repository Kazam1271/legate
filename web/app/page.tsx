import Link from 'next/link';

import { CountUp } from '@/components/count-up';
import { HeroBrand, SealBackdrop } from '@/components/logo';
import { NettingDiagram } from '@/components/netting-diagram';
import { Badge, Card, Eyebrow, Row, ShieldIcon, Stat } from '@/components/ui';
import { PROTOCOL_STATS } from '@/lib/data';
import { ratioPct, utcTime } from '@/lib/format';

const STEPS = [
  {
    n: '01',
    title: 'Strategists submit encrypted intents',
    body: 'A model runs off chain, where nobody — including Legate — can see it. Its order is encrypted to the enclave key and padded to a fixed size before it is ever submitted.',
  },
  {
    n: '02',
    title: 'The enclave nets opposing flow',
    body: 'Inside the TEE, intents across every strategy are matched against each other. Only what is left over is sent to market, as one pooled order with no attribution.',
  },
  {
    n: '03',
    title: 'Depositors see performance, never positions',
    body: 'Backers judge a strategy on attested NAV and its enclave-enforced mandate. The holdings behind that number stay confidential.',
  },
];

export default function OverviewPage() {
  return (
    <>
      <SealBackdrop />

      <section className="relative z-10 mx-auto max-w-[1240px] px-5 pt-16 pb-20 sm:px-8 sm:pt-24">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-16">
          <div className="animate-rise">
            <HeroBrand />

            <h1 className="mt-9 text-[clamp(2.75rem,7vw,4.5rem)] font-semibold leading-[0.98] tracking-[-0.035em]">
              Trade without
              <br />
              <span className="text-accent">being read.</span>
            </h1>

            <p className="mt-7 max-w-xl text-[17px] leading-relaxed text-muted">
              Legate routes encrypted trade intents through a confidential enclave. Opposing flow is
              netted before the market ever sees it.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                href="/vaults"
                className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-[#1a1206] transition-colors hover:bg-accent-bright"
              >
                Explore vaults
                <span aria-hidden>&#8599;</span>
              </Link>
              <Link
                href="/batches"
                className="inline-flex items-center gap-2 rounded-lg border border-line px-5 py-3 text-sm text-fg transition-colors hover:border-line-strong"
              >
                Read the architecture
                <span aria-hidden>&rsaquo;</span>
              </Link>
            </div>
          </div>

          {/* Status panel: everything here is attestable, which is why it is allowed
              to look authoritative. */}
          <Card className="h-fit p-5 lg:mt-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
                Legate / system status
              </p>
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-positive">
                <span className="size-1.5 rounded-full bg-positive" aria-hidden />
                LIVE
              </span>
            </div>

            <div className="divide-y divide-line">
              <Row label="enclave" value={PROTOCOL_STATS.enclave} tone="muted" />
              <Row label="attestation" value={PROTOCOL_STATS.attestation} tone="accent" />
              <Row label="last batch" value={utcTime(PROTOCOL_STATS.lastBatchAt)} tone="muted" />
              <Row label="netting ratio" value={ratioPct(PROTOCOL_STATS.nettingRatio)} tone="accent" />
            </div>

            <div className="mt-4 flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[11px] text-muted">
              <span className="text-accent">
                <ShieldIcon className="size-4" />
              </span>
              All execution paths attested
            </div>
          </Card>
        </div>
      </section>

      {/* The netting property, made visible. */}
      <section className="border-y border-line bg-surface/40">
        <div className="mx-auto max-w-[1240px] px-5 py-16 sm:px-8 sm:py-20">
          <div className="mb-12 max-w-2xl">
            <Eyebrow>How netting hides you</Eyebrow>
            <h2 className="mt-3 text-[28px] font-semibold tracking-[-0.02em] sm:text-[34px]">
              Many private intents. One public order.
            </h2>
          </div>

          <NettingDiagram />
        </div>
      </section>

      {/* Headline numbers. */}
      <section className="mx-auto max-w-[1240px] px-5 py-16 sm:px-8">
        <div className="grid gap-10 border-b border-line pb-14 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Strategies live"
            value={<CountUp value={PROTOCOL_STATS.strategiesLive} format="int" />}
          />
          <Stat
            label="Value in vaults"
            value={<CountUp value={PROTOCOL_STATS.valueInVaults} format="usdCompact" />}
          />
          <Stat
            label="Volume netted"
            value={<CountUp value={PROTOCOL_STATS.nettingRatio} format="ratioPct" />}
            hint="Matched inside the enclave, never seen by the market"
            accent
          />
          <Stat
            label="Batches settled"
            value={<CountUp value={PROTOCOL_STATS.batchesSettled} format="int" />}
          />
        </div>
      </section>

      {/* How it works. */}
      <section className="mx-auto max-w-[1240px] px-5 pb-8 sm:px-8">
        <Eyebrow>How it works</Eyebrow>
        <div className="mt-8 grid gap-px overflow-hidden rounded-[10px] border border-line bg-line sm:grid-cols-3">
          {STEPS.map((step) => (
            <div key={step.n} className="bg-surface p-6">
              <p className="font-mono text-xs text-accent">{step.n}</p>
              <h3 className="mt-4 text-[15px] font-semibold leading-snug">{step.title}</h3>
              <p className="mt-3 text-[13px] leading-relaxed text-muted">{step.body}</p>
            </div>
          ))}
        </div>

        <Card className="mt-10 flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-[15px] font-semibold">See what the chain actually recorded</h3>
            <p className="mt-1.5 text-[13px] text-muted">
              Every settled batch, with the private volume that never reached the market beside it.
            </p>
          </div>
          <Link
            href="/batches"
            className="inline-flex w-fit items-center gap-2 rounded-lg border border-line-strong px-4 py-2.5 text-sm transition-colors hover:border-accent hover:text-accent"
          >
            Batch transparency
            <span aria-hidden>&rsaquo;</span>
          </Link>
        </Card>

        <p className="mt-6 flex flex-wrap items-center gap-2 text-xs text-faint">
          <Badge tone="neutral">Interface preview</Badge>
          Representative data. Not connected to a live deployment.
        </p>
      </section>
    </>
  );
}
