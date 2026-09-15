import type { Metadata } from 'next';

import { VaultExplorer } from '@/components/vault-explorer';
import { PageHeader, ShieldIcon } from '@/components/ui';
import { STRATEGIES } from '@/lib/data';

export const metadata: Metadata = {
  title: 'Vault explorer',
  description: 'Attested strategies for depositors who want performance without exposure.',
};

export default function VaultsPage() {
  return (
    <div className="mx-auto max-w-[1240px] px-5 py-14 sm:px-8">
      <PageHeader
        eyebrow="Capital allocation"
        title="Vault explorer"
        lede="Attested strategies for depositors who want performance without exposure."
        aside={
          <p className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3.5 py-2.5 text-xs text-muted">
            <span className="text-accent">
              <ShieldIcon className="size-4" />
            </span>
            Depositor view &middot; positions never exposed
          </p>
        }
      />

      <VaultExplorer strategies={STRATEGIES} />
    </div>
  );
}
