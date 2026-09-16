import type { Metadata } from 'next';

import { BatchFeed } from '@/components/batch-feed';
import { SealBackdrop } from '@/components/logo';
import { Card, PageHeader, Stat } from '@/components/ui';
import { BATCHES, EPOCH, LAST_24H } from '@/lib/data';
import { num, ratioPct, usdCompact, utcTime } from '@/lib/format';

export const metadata: Metadata = {
  title: 'Batch transparency',
  description: 'Every public order, with the private flow that was netted before it.',
};

export default function BatchesPage() {
  return (
    <>
      <SealBackdrop />
      <div className="relative z-10 mx-auto max-w-[1240px] px-5 py-14 sm:px-8">
      <PageHeader
        eyebrow="Public settlement layer"
        title="Batch transparency"
        lede="Every public order, with the private flow that was netted before it."
        aside={
          <p className="flex items-center gap-2 font-mono text-xs text-muted">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden />
            Feed live
          </p>
        }
      />

      <div className="mt-10 grid gap-8 border-b border-line pb-10 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Batches / last 24h" value={num(LAST_24H.batches, 0)} />
        <Stat label="Average netting" value={ratioPct(LAST_24H.ratio)} accent />
        <Stat label="Total volume" value={usdCompact(LAST_24H.volume)} />
        <Stat
          label="Never touched market"
          value={usdCompact(LAST_24H.crossed)}
          hint="Matched strategy-to-strategy inside the enclave"
          accent
        />
      </div>

      <div className="mt-10 flex items-center justify-between gap-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <span className="size-1.5 rounded-full bg-positive" aria-hidden />
          Settled batches
        </h2>
        <p className="font-mono text-[11px] text-faint">Updated {utcTime(EPOCH)}</p>
      </div>

      <Card className="mt-4 overflow-hidden">
        <BatchFeed batches={BATCHES} />
      </Card>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Card className="p-5">
          <h3 className="text-sm font-semibold">What this page proves</h3>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            Each row is one settled batch. The gold portion of the bar is the residual — the single
            pooled order that reached the market. The rest was matched strategy-to-strategy inside
            the enclave and never existed publicly at all.
          </p>
        </Card>
        <Card className="p-5">
          <h3 className="text-sm font-semibold">What it still does not reveal</h3>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            Not which strategies contributed, not their sides, not their sizes. A batch where every
            intent crossed internally publishes no order at all — it is marked fully private, and
            the chain records nothing to attribute.
          </p>
        </Card>
      </div>
      </div>
    </>
  );
}
