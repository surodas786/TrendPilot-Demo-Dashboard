'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PlusIcon, SlidersHorizontalIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { liveUnavailableReason, MODE_LABELS, type BlockMode, type OrderBlockDto } from '@trendpilot/domain';
import type { InstrumentDto, StrategyVersionDto } from '@trendpilot/db';
import { api, request } from '@/lib/api';
import { PageContainer } from '../layout/PageContainer';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
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
  /** Server-decided: which blocks can be removed now (and how), and why the others are kept. Rechecked when applied. */
  removal?: RemovalPreview;
}

type RemovalReason = { code: string; text: string };
interface RemovalPreview {
  removable: { id: string; symbol: string; exchange: string; mode: string; action: 'DELETE' | 'ARCHIVE' }[];
  excluded: { id: string; symbol: string; exchange: string; mode: string; reasons: RemovalReason[] }[];
}

const actionText = (a: 'DELETE' | 'ARCHIVE') => (a === 'ARCHIVE' ? 'archived: its trade and signal history stays' : 'deleted: it has no trade or signal history');

/** UI-03 Trade Settings for the signed-in investor only. All data arrives owner-scoped from the server. */
export function TradeSettingsClient({ ownerName, timezone, blocks, instruments, versions, liveConnectionStatus, bitunixConnectionStatus = null, lighterConnectionStatus = null, lighterLiveIds = [], removal = { removable: [], excluded: [] } }: Props) {
  const router = useRouter();
  /** One block to remove (row action) or the bulk "Remove unused tokens" preview. */
  const [removing, setRemoving] = useState<OrderBlockDto | 'bulk' | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
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

  const removableOf = (b: OrderBlockDto) => removal.removable.find((x) => x.id === b.id);
  const excludedOf = (b: OrderBlockDto) => removal.excluded.find((x) => x.id === b.id);
  const removeLabel = (x: { symbol: string; exchange: string; mode: string }) => `${x.symbol} · ${exchangeName(x.exchange)} · ${x.mode === 'LIVE' ? 'Live' : 'Paper'}`;

  const confirmRemove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    if (removing === 'bulk') {
      const r = await request<{ removed: { id: string; symbol: string; result: string }[]; kept: { id: string; symbol: string | null; reasons: RemovalReason[] }[] }>('POST', '/v1/me/order-blocks/removal', { body: { ids: removal.removable.map((x) => x.id) } });
      setRemoveBusy(false);
      setRemoving(null);
      if (!r.ok) toast.error('Nothing removed', { description: r.message });
      else {
        toast.success(`${r.data.removed.length} order block(s) removed`, {
          description: r.data.kept.length ? `Kept (changed since the preview): ${r.data.kept.map((k) => `${k.symbol ?? 'unknown'} — ${k.reasons.map((x) => x.text).join(' ') || 'not found'}`).join('; ')}` : undefined
        });
      }
    } else {
      const r = await request<{ result: string }>('DELETE', `/v1/me/order-blocks/${removing.id}`);
      setRemoveBusy(false);
      setRemoving(null);
      if (!r.ok) toast.error('Not removed', { description: r.message });
      else toast.success(`${labelOf(removing)} removed`, { description: r.data.result === 'ARCHIVED' ? 'Archived: its trade and signal history stays.' : 'Deleted.' });
    }
    router.refresh();
  };

  return (
    <PageContainer
      title="Trade Settings"
      description="Configure how each token trades on shared signals: strategy, sizing, exits, trading days and pause controls in one order block."
      scope={`${ownerName} · My Account · Paper simulates MEXC pairs; Live trades MEXC or Bitunix pairs on your own exchange account`}
      actions={
        <div className="flex flex-wrap gap-2">
          {blocks.length > 0 && (
            <Button variant="secondary" icon={Trash2Icon} onClick={() => setRemoving('bulk')} data-testid="remove-unused">
              Remove unused tokens
            </Button>
          )}
          <Button variant="primary" icon={PlusIcon} onClick={() => setEditing('new')} disabled={!canAdd} title={canAdd ? undefined : 'No approved pair is free: each already has an entry in every mode it supports (Bitunix pairs are Live only and need a verified Bitunix connection).'}>
            Add Token
          </Button>
        </div>
      }
    >
      {blocks.length === 0 ? (
        <EmptyState icon={SlidersHorizontalIcon} title="No order blocks yet" body="Add a token to configure how it trades on shared signals. New blocks start paused." />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {blocks.map((b) => (
            <OrderBlockRow
              key={b.id}
              block={b}
              pairLabel={labelOf(b)}
              contract={contractOf(b)}
              currency={instruments.find((x) => x.id === b.instrumentId)?.quote}
              strategyName={strategyOf(b)}
              busy={busyId === b.id}
              onEdit={() => setEditing(b.id)}
              onToggle={() => toggle(b)}
              onRemove={removableOf(b) ? () => setRemoving(b) : undefined}
              keptBecause={b.status === 'PAUSED' ? excludedOf(b)?.reasons.map((x) => x.text).join(' ') : undefined}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={removing !== null}
        title={removing === 'bulk' ? 'Remove unused tokens' : removing ? `Remove ${labelOf(removing)} · ${removing.mode === 'LIVE' ? 'Live' : 'Paper'}?` : ''}
        tone="danger"
        confirmLabel={removing === 'bulk' ? `Remove ${removal.removable.length} order block(s)` : 'Remove'}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removeBusy || (removing === 'bulk' && !removal.removable.length)) return;
          void confirmRemove();
        }}
        description={
          removing === 'bulk' ? (
            <div className="space-y-3 text-sm" data-testid="remove-preview">
              {removal.removable.length ? (
                <div>
                  <p className="font-medium text-ink">These {removal.removable.length} paused, unused order block(s) will be removed:</p>
                  <ul className="mt-1 list-disc pl-5 text-muted" data-testid="remove-preview-removable">
                    {removal.removable.map((x) => (
                      <li key={x.id}>
                        {removeLabel(x)} — {actionText(x.action)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-muted">No order block can be removed right now.</p>
              )}
              {removal.excluded.length > 0 && (
                <div>
                  <p className="font-medium text-ink">Kept:</p>
                  <ul className="mt-1 list-disc pl-5 text-muted" data-testid="remove-preview-excluded">
                    {removal.excluded.map((x) => (
                      <li key={x.id}>
                        {removeLabel(x)} — {x.reasons.map((r) => r.text).join(' ')}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-xs text-subtle">Each block is checked again when you confirm; one that became active or got an order in the meantime is kept. Trading pairs stay available to add again.</p>
            </div>
          ) : removing ? (
            <p className="text-sm text-muted">
              This order block will be {actionText(removableOf(removing)?.action ?? 'ARCHIVE')}. It is checked again on the server before removal. The trading pair stays available to add again.
            </p>
          ) : null
        }
      />

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
