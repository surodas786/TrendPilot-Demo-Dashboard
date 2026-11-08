import React, { useRef, useState } from 'react';
import { ScissorsIcon, ShieldCheckIcon, XCircleIcon } from 'lucide-react';
import { exchanges } from '../../../data/mockData';
import { useDemo } from '../../../contexts/DemoContext';
import { dayTimeToMs, demoStartTime } from '../../../utils/clock';
import { isWorking, workingStop } from '../../../utils/orders';
import { protectionInfo } from '../../../utils/protection';
import { realizedFor } from '../../../utils/positionDetail';
import { cn } from '../../../utils/cn';
import { Button } from '../../ui/Button';
import { DirectionBadge } from '../../ui/DirectionBadge';
import { SidePanel } from '../../ui/SidePanel';
import { StatusPill } from '../../ui/StatusPill';
import { ProtectionPill } from '../../dashboard/ProtectionPill';
import { ClosePositionsDialog } from '../ClosePositionsDialog';
import type { CloseMode } from '../ClosePositionsDialog';
import { TightenStopDialog, tightenUnavailableReason } from '../TightenStopDialog';
import { ExitPlanTab } from './ExitPlanTab';
import { OrdersFillsTab } from './OrdersFillsTab';
import { OverviewTab } from './OverviewTab';
import { SimulatedCandleChart } from './SimulatedCandleChart';
import type { ChartFill, ChartLevel } from './SimulatedCandleChart';
import { TimelineTab } from './TimelineTab';
import type { TradeRecord } from '../../../types/execution';
import type { Position } from '../../../types/trading';

type Tab = 'overview' | 'chart' | 'exit' | 'orders' | 'timeline';
const TABS: {id: Tab;label: string;}[] = [
{ id: 'overview', label: 'Overview' },
{ id: 'chart', label: 'Chart' },
{ id: 'exit', label: 'Exit plan' },
{ id: 'orders', label: 'Orders & fills' },
{ id: 'timeline', label: 'Timeline' }];


/** Shared detail view: open positions are actionable; completed trades open read-only. */
export function PositionDetailPanel({ positionId, onClose }: {positionId: string | null;onClose: () => void;}) {
  const { state } = useDemo();
  const open = positionId ? state.positions.find((p) => p.id === positionId) ?? null : null;
  const trade = positionId && !open ? state.tradeRecords.find((t) => t.positionId === positionId) ?? null : null;
  const current = open ?? trade?.snapshot ?? null;
  const last = useRef<{position: Position;trade: TradeRecord | null;} | null>(null);
  if (current) last.current = { position: current, trade };
  const shown = current ? { position: current, trade } : last.current;
  const [tab, setTab] = useState<Tab>('overview');
  const [closeMode, setCloseMode] = useState<CloseMode | null>(null);
  const [tightenFor, setTightenFor] = useState<Position | null>(null);
  const dialogOpen = closeMode !== null || tightenFor !== null;

  return (
    <>
      <SidePanel
        open={Boolean(current)}
        onClose={onClose}
        escapeEnabled={!dialogOpen}
        widthClassName="sm:w-[760px]"
        title={
        shown &&
        <div className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-semibold text-ink">{shown.position.pair}</span>
              <DirectionBadge direction={shown.position.direction} />
              {shown.trade ? <StatusPill tone="neutral">Completed trade · read-only</StatusPill> : <PanelProtection position={shown.position} />}
            </div>

        }
        subtitle={shown && `${exchanges.find((e) => e.id === shown.position.exchangeId)?.name ?? ''} · ${shown.trade ? shown.trade.id : shown.position.id} · paper simulation`}
        footer={open && open.managed !== false ? <Actions position={open} onClose={setCloseMode} onTighten={() => setTightenFor(open)} /> : undefined}>
        
        {shown &&
        <div className="space-y-5">
            <div role="tablist" aria-label="Position detail sections" className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1">
              {TABS.map((t) =>
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                tab === t.id ? 'bg-inset text-ink' : 'text-muted hover:text-ink'
              )}>
              
                  {t.label}
                </button>
            )}
            </div>
            <div role="tabpanel">
              <TabContent tab={tab} position={shown.position} trade={shown.trade} />
            </div>
          </div>
        }
      </SidePanel>
      {shown &&
      <ClosePositionsDialog open={closeMode !== null} accountId={shown.position.accountId} positionIds={[shown.position.id]} mode={closeMode ?? 'full'} onClose={() => setCloseMode(null)} />
      }
      <TightenStopDialog
        position={tightenFor}
        onClose={() => setTightenFor(null)}
        onRequestClose={() => {
          setTightenFor(null);
          setCloseMode('full');
        }} />
      
    </>);

}

function PanelProtection({ position }: {position: Position;}) {
  const { state, accountById } = useDemo();
  const info = protectionInfo(position, accountById(position.accountId), state.orders);
  return <ProtectionPill status={info.status} title={info.note} />;
}

function TabContent({ tab, position: p, trade }: {tab: Tab;position: Position;trade: TradeRecord | null;}) {
  const { state, accountName } = useDemo();
  const orders = state.orders.filter((o) => o.positionId === p.id);
  const realized = realizedFor(state.closedTrades, p.id);
  if (tab === 'overview') return <OverviewTab position={p} trade={trade} realized={realized} accountName={accountName(p.accountId)} />;
  if (tab === 'exit') return <ExitPlanTab position={p} orders={trade ? [] : orders} closed={Boolean(trade)} />;
  if (tab === 'orders') return <OrdersFillsTab orders={orders} />;
  if (tab === 'timeline') return <TimelineTab position={p} orders={orders} activity={state.activity.filter((e) => e.positionId === p.id)} signals={state.signals} />;

  const startMs = dayTimeToMs(p.openedAt);
  const endMs = trade ? Math.max(trade.exitAt, startMs + 3600000) : Math.max(demoStartTime(), startMs + 3600000);
  const levels: ChartLevel[] = [{ label: 'Entry', price: p.entryPrice, tone: 'accent' }];
  if (!trade) {
    const stop = workingStop(orders, p.id);
    if (stop?.price) levels.push({ label: 'Stop', price: stop.price, tone: 'loss' });
    orders.
    filter((o) => o.purpose === 'take-profit' && isWorking(o) && o.price !== null).
    forEach((o, i, arr) => levels.push({ label: arr.length > 1 ? `TP${i + 1}` : 'Target', price: o.price as number, tone: 'gain' }));
  }
  const fills: ChartFill[] = orders.flatMap((o) => o.fills.map((f) => ({ at: f.at, price: f.price, label: `${o.purpose === 'entry' ? 'Entry' : 'Exit'} fill` })));
  return (
    <div className="space-y-3">
      <SimulatedCandleChart seed={p.id} startMs={startMs} endMs={endMs} startPrice={p.entryPrice} endPrice={trade ? trade.avgExit : p.markPrice} priceDecimals={p.priceDecimals} levels={levels} fills={fills} />
      {!trade && !levels.some((l) => l.label === 'Stop') && <p className="text-xs text-warn">No stop level shown — no confirmed resting stop record exists.</p>}
      <p className="text-xs text-subtle">Trailing levels: not recorded in this demo.</p>
    </div>);

}

function Actions({ position: p, onClose, onTighten }: {position: Position;onClose: (m: CloseMode) => void;onTighten: () => void;}) {
  const { state, accountById } = useDemo();
  const unavailable = tightenUnavailableReason(p, accountById(p.accountId), state.orders);
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-3">
        <Button variant="danger" icon={XCircleIcon} onClick={() => onClose('full')}>
          Close full
        </Button>
        <Button icon={ScissorsIcon} onClick={() => onClose('partial')}>
          Close part
        </Button>
        <Button icon={ShieldCheckIcon} onClick={onTighten} disabled={Boolean(unavailable)} title={unavailable ?? undefined}>
          Tighten stop
        </Button>
      </div>
      <p className="text-center text-xs text-subtle">{unavailable ? `Tighten stop unavailable: ${unavailable}` : 'Paper actions only — no real order is sent. Entry pauses never block closing.'}</p>
    </div>);

}