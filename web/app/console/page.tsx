import type { Metadata } from 'next';

import { StrategistConsole } from '@/components/strategist-console';
import { LockIcon, PageHeader } from '@/components/ui';
import { MY_STRATEGY_IDS, PRIVATE_FILLS, QUEUED_INTENTS, STRATEGIES } from '@/lib/data';

export const metadata: Metadata = {
  title: 'Strategist console',
  description: 'Submit encrypted intents and read your own private fills.',
};

export default function ConsolePage() {
  const mine = STRATEGIES.filter((s) => MY_STRATEGY_IDS.includes(s.id));

  return (
    <div className="mx-auto max-w-[1240px] px-5 py-14 sm:px-8">
      <PageHeader
        eyebrow="Strategist console"
        title="Submit an intent"
        lede="Orders are encrypted in your browser, checked against your mandate inside the enclave, and netted against other strategies before anything reaches the market."
        aside={
          <p className="flex items-center gap-2 rounded-lg border border-private/25 bg-private/[0.06] px-3.5 py-2.5 text-xs text-muted">
            <span className="text-private">
              <LockIcon className="size-3.5" />
            </span>
            Authenticated manager view
          </p>
        }
      />

      <StrategistConsole strategies={mine} fills={PRIVATE_FILLS} queued={QUEUED_INTENTS} />
    </div>
  );
}
