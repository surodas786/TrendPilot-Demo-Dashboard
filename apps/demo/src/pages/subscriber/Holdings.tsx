import React, { useMemo, useState } from 'react';
import { useDemo } from '../../contexts/DemoContext';
import { usePlatform } from '../../contexts/PlatformContext';
import { fillModelNote } from '../../contexts/signals/tokenExecution';
import { GROSS_NOTE, MODEL_NOTE } from '../../utils/holdingsMath';
import { migratedToView, positionToView, tradeToView, unrealizedOf } from '../../utils/holdingsView';
import { MODE_LABEL } from '../../utils/tokenBlocks';
import { PageContainer } from '../../components/layout/PageContainer';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { TabBar } from '../../components/ui/TabBar';
import { SignedPnl } from '../../components/holdings/SignedPnl';
import { OpenPositionsTable } from '../../components/holdings/OpenPositionsTable';
import { ClosedTradesTable } from '../../components/holdings/ClosedTradesTable';
import { PositionDrawer } from '../../components/holdings/PositionDrawer';
import { ClosePositionDialog } from '../../components/holdings/ClosePositionDialog';

type Tab = 'open' | 'closed';
type Mode = 'paper' | 'live';

/**
 * Reads the same position, ledger and trade records as the Dashboard and Trade History.
 * Scope is the signed-in investor's My Account, in the Paper or Live — simulated mode chosen in the header.
 */
export function Holdings() {
  const { state, currentUser, accounts, account, selectPosition } = useDemo();
  const { platform } = usePlatform();
  const [mode, setMode] = useState<Mode>(accounts.length > 0 ? account.environment : 'paper');
  const [tab, setTab] = useState<Tab>('open');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [closeId, setCloseId] = useState<string | null>(null);

  // My Account: only the signed-in investor's own records, Paper and Live — simulated kept separate.
  const hasLive = accounts.some((a) => a.environment === 'live');
  const ids = useMemo(() => new Set(accounts.filter((a) => a.environment === mode).map((a) => a.id)), [accounts, mode]);
  const showMigrated = mode === 'paper';
  const migrated = useMemo(() => showMigrated ? platform.positions.filter((p) => p.subscriberId === currentUser.id).map((p) => migratedToView(p, platform.prices[p.symbol]?.price)) : [], [showMigrated, platform.positions, platform.prices, currentUser.id]);

  const open = useMemo(
    () => [...state.positions.filter((p) => ids.has(p.accountId)).map((p) => positionToView(state, p)), ...migrated.filter((m) => m.status === 'open')].sort((a, b) => b.openedAt - a.openedAt),
    [state, ids, migrated]
  );
  const closed = useMemo(
    () => [...state.tradeRecords.filter((t) => ids.has(t.accountId)).map((t) => tradeToView(state, t)), ...migrated.filter((m) => m.status === 'closed')].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)),
    [state, ids, migrated]
  );

  // Realized = every closing fill in scope (partials on open positions included, counted once).
  const linked = state.closedTrades.filter((t) => ids.has(t.accountId) && (t.kind === 'partial' || t.kind === 'final'));
  const realizedGross = linked.reduce((s, t) => s + t.grossPnl, 0);
  const fees = state.closedTrades.filter((t) => ids.has(t.accountId) && (t.kind === 'partial' || t.kind === 'final' || t.kind === 'entry-fee')).reduce((s, t) => s + t.commission, 0);
  const unreal = open.filter((p) => p.kind !== 'migrated').reduce((s, p) => s + unrealizedOf(p), 0);
  const migratedOpen = migrated.filter((m) => m.status === 'open');

  const labelOf = (symbol: string) => {
    const p = platform.pairs.find((x) => x.symbol === symbol);
    return p ? `${p.base}/${p.quote}` : symbol;
  };
  const all = [...open, ...closed];
  const detail = all.find((p) => p.id === detailId);
  const closing = open.find((p) => p.id === closeId);
  const scopeLabel = `My Account · ${MODE_LABEL[mode]}`;

  const openDetail = (id: string) => {
    const v = all.find((p) => p.id === id);
    // Original sample positions use the shared position detail panel (exit plan, orders, timeline).
    if (v?.kind === 'legacy') selectPosition(id);else
    setDetailId(id);
  };

  return (
    <PageContainer title="Holdings" description="Your simulated positions and results — the same records shown on the Dashboard and in Trade History." scope={`${currentUser.name} · ${scopeLabel}`}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <dl className="flex flex-wrap gap-x-10 gap-y-3">
          <div>
            <dt className="text-xs text-subtle">Realized gross P&amp;L</dt>
            <dd className="mt-0.5 text-2xl font-semibold"><SignedPnl value={realizedGross} /></dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Fees</dt>
            <dd className="mt-0.5 text-2xl font-semibold tabular-nums text-ink">{fees.toFixed(2)}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Net realized</dt>
            <dd className="mt-0.5 text-2xl font-semibold"><SignedPnl value={realizedGross - fees} /></dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Unrealized P&amp;L</dt>
            <dd className="mt-0.5 text-2xl font-semibold"><SignedPnl value={unreal} /></dd>
          </div>
        </dl>
        {hasLive &&
        <div className="w-full max-w-xs">
            <SegmentedControl<Mode>
            label="Mode"
            value={mode}
            onChange={setMode}
            options={[
            { value: 'paper', label: 'Paper' },
            { value: 'live', label: 'Live — simulated' }]
            } />
          
          </div>
        }
      </div>
      <p className="text-xs text-subtle">
        {fillModelNote(state.simFeeRatePct)} {MODEL_NOTE} Totals exclude seeded opening summaries; see Funds &amp; Funding for the full ledger.
      </p>
      {migratedOpen.length > 0 &&
      <p className="rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn">
          {migratedOpen.length} migrated holding{migratedOpen.length === 1 ? '' : 's'} saved before trading accounts existed {migratedOpen.length === 1 ? 'is' : 'are'} shown as “Unassigned — migrated”. {GROSS_NOTE} They keep their exits but are not counted in any account balance or in the totals above.
        </p>
      }

      <TabBar<Tab>
        label="Holdings"
        value={tab}
        onChange={setTab}
        tabs={[
        { id: 'open', label: `Open Positions (${open.length})` },
        { id: 'closed', label: `Closed Trades (${closed.length})` }]
        } />
      
      {tab === 'open' ? <OpenPositionsTable positions={open} labelOf={labelOf} onOpen={openDetail} onClose={setCloseId} /> : <ClosedTradesTable positions={closed} labelOf={labelOf} />}

      <p className="text-xs text-subtle">Current prices come from the shared simulated price for each pair. Only the administrator can change demo prices.</p>

      <PositionDrawer position={detail} pairLabel={detail ? labelOf(detail.symbol) : ''} onClose={() => setDetailId(null)} onRequestClose={setCloseId} />
      <ClosePositionDialog position={closing} pairLabel={closing ? labelOf(closing.symbol) : ''} onClose={() => setCloseId(null)} />
    </PageContainer>);

}