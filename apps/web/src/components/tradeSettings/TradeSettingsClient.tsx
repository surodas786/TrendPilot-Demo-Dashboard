'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PlusIcon, SlidersHorizontalIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { OrderBlockDto } from '@trendpilot/domain';
import type { InstrumentDto, StrategyVersionDto } from '@trendpilot/db';
import { api } from '@/lib/api';
import { PageContainer } from '../layout/PageContainer';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { SidePanel } from '../ui/SidePanel';
import { pairLabel } from './draft';
import { OrderBlockEditor } from './OrderBlockEditor';
import { OrderBlockRow } from './OrderBlockRow';

interface Props {
  ownerName: string;
  timezone: string;
  blocks: OrderBlockDto[];
  instruments: InstrumentDto[];
  versions: StrategyVersionDto[];
}

/** UI-03 Trade Settings for the signed-in investor only. All data arrives owner-scoped from the server. */
export function TradeSettingsClient({ ownerName, timezone, blocks, instruments, versions }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const existing = editing && editing !== 'new' ? blocks.find((b) => b.id === editing) : undefined;
  const taken = blocks.filter((b) => b.mode === 'PAPER').map((b) => b.instrumentId);
  const canAdd = instruments.some((i) => !taken.includes(i.id) && versions.some((v) => v.isLatest && v.instrumentIds.includes(i.id)));
  const labelOf = (b: OrderBlockDto) => {
    const i = instruments.find((x) => x.id === b.instrumentId);
    return i ? pairLabel(i) : b.symbol;
  };
  const strategyOf = (b: OrderBlockDto) => {
    const v = versions.find((x) => x.id === b.strategyVersionId);
    return v ? `${v.packageName} · v${v.version}${v.isLatest ? '' : ' (pinned)'}` : 'Unpublished strategy version';
  };

  const toggle = async (b: OrderBlockDto) => {
    setBusyId(b.id);
    const r = b.status === 'ACTIVE' ? await api.pauseBlock(b.id, b.revision) : await api.resumeBlock(b.id, b.revision);
    setBusyId(null);
    if (!r.ok) {
      toast.error(b.status === 'ACTIVE' ? 'Could not pause' : 'Cannot resume', { description: r.code === 'REVISION_CONFLICT' ? 'This block changed elsewhere. The list has been refreshed.' : r.message });
      router.refresh();
      return;
    }
    if (r.data.status === 'PAUSED') toast('Block paused', { description: 'New entries stop. Exits on open positions keep working.' });
    else toast.success('Block resumed — waiting for signal');
    router.refresh();
  };

  return (
    <PageContainer
      title="Trade Settings"
      description="Configure how each token trades on shared signals: strategy, sizing, exits, trading days and pause controls in one order block."
      scope={`${ownerName} · My Account · Paper only — live trading is disabled in this build`}
      actions={
        <Button variant="primary" icon={PlusIcon} onClick={() => setEditing('new')} disabled={!canAdd} title={canAdd ? undefined : 'Every approved pair already has a Paper block'}>
          Add Token
        </Button>
      }
    >
      {blocks.length === 0 ? (
        <EmptyState icon={SlidersHorizontalIcon} title="No order blocks yet" body="Add a token to configure how it trades on shared signals. New blocks start paused." />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {blocks.map((b) => (
            <OrderBlockRow key={b.id} block={b} pairLabel={labelOf(b)} strategyName={strategyOf(b)} busy={busyId === b.id} onEdit={() => setEditing(b.id)} onToggle={() => toggle(b)} />
          ))}
        </ul>
      )}

      <SidePanel
        open={editing !== null}
        onClose={() => setEditing(null)}
        widthClassName="sm:w-[540px]"
        bodyClassName="flex min-h-0 flex-1 flex-col"
        title={<h2 className="text-base font-semibold text-ink">{existing ? `${labelOf(existing)} · Paper` : 'Add Token'}</h2>}
        subtitle={existing ? 'Changes apply to future entries only.' : 'Saved blocks start paused unless you activate them.'}
      >
        {editing !== null && (
          <OrderBlockEditor
            key={`${editing}-${existing?.revision ?? 0}`}
            existing={existing}
            instruments={instruments}
            versions={versions}
            takenInstrumentIds={taken}
            timezone={timezone}
            onDone={(saved) => {
              setEditing(null);
              if (saved) router.refresh();
            }}
          />
        )}
      </SidePanel>
    </PageContainer>
  );
}
