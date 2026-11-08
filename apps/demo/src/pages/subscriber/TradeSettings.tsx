import React, { useState } from 'react';
import { PlusIcon, SlidersHorizontalIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useDemo } from '../../contexts/DemoContext';
import { usePlatform } from '../../contexts/PlatformContext';
import { activationBlocker, blockStatus, BOTH_MODES_NOTE, MODE_LABEL } from '../../utils/tokenBlocks';
import { PageContainer } from '../../components/layout/PageContainer';
import { EmptyState } from '../../components/ui/EmptyState';
import { Button } from '../../components/ui/Button';
import { SidePanel } from '../../components/ui/SidePanel';
import { TokenBlockRow } from '../../components/tradeSettings/TokenBlockRow';
import { TokenBlockEditor } from '../../components/tradeSettings/TokenBlockEditor';

export function TradeSettings() {
  const { currentUser, accounts } = useDemo();
  const { platform, connectionFor, setTokenBlockActive } = usePlatform();
  const [editing, setEditing] = useState<string | 'new' | null>(null);

  // Only the signed-in investor's own blocks; every block trades with My Account.
  const blocks = platform.tokenBlocks.filter((b) => b.subscriberId === currentUser.id);
  const ctx = { pairs: platform.pairs, packages: platform.packages, connection: connectionFor(currentUser.id), subscriberActive: currentUser.status === 'active', accounts };
  const existing = editing && editing !== 'new' ? blocks.find((b) => b.id === editing) : undefined;
  const canAdd = platform.pairs.some((p) => p.enabled) && platform.packages.some((p) => p.status === 'active');
  const labelOf = (symbol: string) => {
    const p = platform.pairs.find((x) => x.symbol === symbol);
    return p ? `${p.base}/${p.quote}` : symbol;
  };

  const toggle = (id: string) => {
    const b = blocks.find((x) => x.id === id);
    if (!b) return;
    if (b.active) {
      setTokenBlockActive(currentUser.id, b.id, false);
      toast('Block paused', { description: 'New entries stop. Exits on open positions keep working.' });
      return;
    }
    const reason = activationBlocker(b, ctx);
    if (reason) {
      toast.error('Cannot resume', { description: reason });
      return;
    }
    setTokenBlockActive(currentUser.id, b.id, true);
    toast.success('Block resumed — waiting for signal');
  };

  return (
    <PageContainer
      title="Trade Settings"
      description="Configure how each token trades on common signals: sizing, exits and pause controls in one order block."
      scope={`${currentUser.name} · My Account · ${BOTH_MODES_NOTE}`}
      actions={
      <Button variant="primary" icon={PlusIcon} onClick={() => setEditing('new')} disabled={!canAdd} title={canAdd ? undefined : 'No enabled pairs or active packages are available'}>
          Add Token
        </Button>
      }>
      
      {blocks.length === 0 ?
      <EmptyState icon={SlidersHorizontalIcon} title="No token blocks yet" body="Add a token to configure how it trades on common signals." /> :

      <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {blocks.map((b) =>
        <TokenBlockRow
          key={b.id}
          block={b}
          pairLabel={labelOf(b.symbol)}
          packageName={platform.packages.find((p) => p.id === b.packageId)?.name ?? 'Removed package'}
          status={blockStatus(b, ctx)}
          timezone={currentUser.timezone || 'Asia/Dhaka'}
          onEdit={() => setEditing(b.id)}
          onToggle={() => toggle(b.id)} />

        )}
        </ul>
      }

      <SidePanel
        open={editing !== null}
        onClose={() => setEditing(null)}
        widthClassName="sm:w-[520px]"
        bodyClassName="flex min-h-0 flex-1 flex-col"
        title={<h2 className="text-base font-semibold text-ink">{existing ? `${labelOf(existing.symbol)} · ${MODE_LABEL[existing.mode]}` : 'Add Token'}</h2>}
        subtitle={existing ? 'Changes apply to future entries only.' : 'Saved blocks start paused unless you activate them.'}>
        
        {editing !== null && <TokenBlockEditor key={editing} existing={existing} onDone={() => setEditing(null)} />}
      </SidePanel>
    </PageContainer>);

}