'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PlusIcon, SlidersHorizontalIcon } from 'lucide-react';
import { toast } from 'sonner';
import { liveUnavailableReason, MODE_LABELS, type BlockMode, type OrderBlockDto } from '@trendpilot/domain';
import type { InstrumentDto, StrategyVersionDto } from '@trendpilot/db';
import { api } from '@/lib/api';
import { PageContainer } from '../layout/PageContainer';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { SidePanel } from '../ui/SidePanel';
import { exchangeName, pairLabel, supportsMode } from './draft';
import { OrderBlockEditor } from './OrderBlockEditor';
import { OrderBlockRow } from './OrderBlockRow';

interface Props {
  ownerName: string;
  timezone: string;
  blocks: OrderBlockDto[];
  instruments: InstrumentDto[];
  versions: StrategyVersionDto[];
  /** Status of the investor's MEXC connection (null = none); Live needs VERIFIED. */
  liveConnectionStatus: string | null;
  /** The investor's Bitunix connection (Live on Bitunix contracts needs it verified). */
  bitunixConnectionStatus?: string | null;
  /** The investor's Lighter connection, and the Lighter markets in their Lighter Live scope (server-decided). */
  lighterConnectionStatus?: string | null;
  lighterLiveIds?: string[];
}

/** UI-03 Trade Settings for the signed-in investor only. All data arrives owner-scoped from the server. */
export function TradeSettingsClient({ ownerName, timezone, blocks, instruments, versions, liveConnectionStatus, bitunixConnectionStatus = null, lighterConnectionStatus = null, lighterLiveIds = [] }: Props) {
  const router = useRouter();
  /** A saved block id, 'new', or a new block prefilled from a saved one in the other mode. */
  const [editing, setEditing] = useState<string | 'new' | { copyFrom: OrderBlockDto; mode: BlockMode } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const existing = typeof editing === 'string' && editing !== 'new' ? blocks.find((b) => b.id === editing) : undefined;
  const copy = editing && typeof editing === 'object' ? editing : undefined;
  const takenByMode = { PAPER: blocks.filter((b) => b.mode === 'PAPER').map((b) => b.instrumentId), LIVE: blocks.filter((b) => b.mode === 'LIVE').map((b) => b.instrumentId) };
  const tradable = (i: InstrumentDto) => versions.some((v) => v.isLatest && v.instrumentIds.includes(i.id));
  const liveFor = (i: InstrumentDto) =>
    liveUnavailableReason(i.exchange === 'BITUNIX' ? bitunixConnectionStatus : i.exchange === 'MEXC' ? liveConnectionStatus : i.exchange === 'LIGHTER' ? lighterConnectionStatus : null, i.exchange, { lighterLive: lighterLiveIds.includes(i.id) }) === null;
  const canAdd = instruments.some((i) => tradable(i) && ((supportsMode(i, 'PAPER') && !takenByMode.PAPER.includes(i.id)) || (liveFor(i) && !takenByMode.LIVE.includes(i.id))));
  const contractOf = (b: OrderBlockDto) => {
    const i = instruments.find((x) => x.id === b.instrumentId);
    return i ? `${exchangeName(i.exchange)} · ${i.exchangeSymbol}${i.marketId !== null ? ` (market ${i.marketId})` : ''}` : b.exchange;
  };
  const labelOf = (b: OrderBlockDto) => {
    const i = instruments.find((x) => x.id === b.instrumentId);
    return i ? pairLabel(i) : b.symbol;
  };
  const strategyOf = (b: OrderBlockDto) => {
    const v = versions.find((x) => x.id === b.strategyVersionId);
    return v ? `${v.packageName} · v${v.version} · ${v.timeframe}${v.isLatest ? '' : ' (pinned)'}` : 'Unpublished strategy version';
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
      scope={`${ownerName} · My Account · Paper simulates MEXC pairs; Live trades MEXC or Bitunix pairs on your own exchange account`}
      actions={
        <Button variant="primary" icon={PlusIcon} onClick={() => setEditing('new')} disabled={!canAdd} title={canAdd ? undefined : 'No approved pair is free: each already has an entry in every mode it supports (Bitunix pairs are Live only and need a verified Bitunix connection).'}>
          Add Token
        </Button>
      }
    >
      {blocks.length === 0 ? (
        <EmptyState icon={SlidersHorizontalIcon} title="No order blocks yet" body="Add a token to configure how it trades on shared signals. New blocks start paused." />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {blocks.map((b) => (
            <OrderBlockRow key={b.id} block={b} pairLabel={labelOf(b)} contract={contractOf(b)} currency={instruments.find((x) => x.id === b.instrumentId)?.quote} strategyName={strategyOf(b)} busy={busyId === b.id} onEdit={() => setEditing(b.id)} onToggle={() => toggle(b)} />
          ))}
        </ul>
      )}

      <SidePanel
        open={editing !== null}
        onClose={() => setEditing(null)}
        widthClassName="sm:w-[540px]"
        bodyClassName="flex min-h-0 flex-1 flex-col"
        title={
          <h2 className="text-base font-semibold text-ink">
            {existing ? `${labelOf(existing)} · ${MODE_LABELS[existing.mode as BlockMode]}` : copy ? `${labelOf(copy.copyFrom)} · new ${MODE_LABELS[copy.mode]} entry` : 'Add Token'}
          </h2>
        }
        subtitle={existing ? 'Changes apply to future entries only.' : 'Saved blocks start paused unless you activate them.'}
      >
        {editing !== null && (
          <OrderBlockEditor
            key={copy ? `copy-${copy.copyFrom.id}-${copy.mode}` : `${editing}-${existing?.revision ?? 0}`}
            existing={existing}
            copyFrom={copy ? { block: copy.copyFrom, mode: copy.mode } : undefined}
            onEditBlock={(id) => setEditing(id)}
            onCopyToMode={(block, mode) => setEditing({ copyFrom: block, mode })}
            instruments={instruments}
            versions={versions}
            takenByMode={takenByMode}
            liveConnectionStatus={liveConnectionStatus}
            bitunixConnectionStatus={bitunixConnectionStatus}
            lighterConnectionStatus={lighterConnectionStatus}
            lighterLiveIds={lighterLiveIds}
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
