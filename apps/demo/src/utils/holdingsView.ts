import { dayTimeToMs } from './clock';
import { strategyName } from './strategies';
import { ownerOf } from '../data/demoUsers';
import type { DemoState } from '../contexts/demoReducer';
import type { TradeRecord } from '../types/execution';
import type { ExitFill, HoldingPosition, HoldingView } from '../types/holdings';
import type { DemoAccount, Position } from '../types/trading';

/** Exit fills for a position, read from the shared ledger (one row per closing fill). */
function exitsFor(state: DemoState, positionId: string): ExitFill[] {
  return state.closedTrades.
  filter((t) => t.positionId === positionId && (t.kind === 'partial' || t.kind === 'final')).
  map((t) => ({ id: t.id, at: t.at ?? 0, price: t.fillPrice ?? 0, qty: t.quantity ?? 0, pnl: t.grossPnl, reason: t.reason ?? (t.kind === 'final' ? 'Close' : 'Partial close') }));
}

function feesFor(state: DemoState, positionId: string): number {
  return state.closedTrades.filter((t) => t.positionId === positionId).reduce((a, t) => a + t.commission, 0);
}

const modeOf = (a?: DemoAccount) => (a?.environment === 'live' ? 'live' : 'paper') as HoldingPosition['mode'];

/** Converts a shared Position record into a Holdings row. Token and original positions share one shape. */
export function positionToView(state: DemoState, p: Position, extra?: {status: 'open' | 'closed';closedAt?: number;closeReason?: string;gross?: number;fees?: number;}): HoldingView {
  const account = state.accounts.find((a) => a.id === p.accountId);
  const rt = p.tokenRuntime;
  const exits = exitsFor(state, p.id);
  const realized = extra?.gross ?? exits.reduce((a, e) => a + e.pnl, 0);
  const status = extra?.status ?? 'open';
  const targets = rt ?
  rt.targets.map((t) => status === 'closed' && t.state === 'open' ? { ...t, state: 'cancelled' as const } : t) :
  [];
  return {
    kind: rt ? 'token' : 'legacy',
    accountId: p.accountId,
    accountLabel: account?.name ?? 'Unknown account',
    fees: extra?.fees ?? feesFor(state, p.id),
    currentPrice: status === 'open' ? p.markPrice : undefined,
    id: p.id,
    subscriberId: ownerOf(account),
    blockId: rt?.blockId ?? '',
    mode: modeOf(account),
    symbol: p.pair,
    side: p.direction,
    packageId: rt?.packageId ?? p.strategyId,
    packageName: rt?.packageName ?? p.subscriptionLabel ?? strategyName(p.strategyId),
    receiptId: rt?.receiptId ?? '',
    signalId: rt?.signalId ?? p.sourceSignalId ?? 'Not recorded',
    entryPrice: p.entryPrice,
    originalQty: rt?.originalQty ?? p.quantity + p.closedQuantity,
    remainingQty: status === 'closed' ? 0 : p.quantity,
    orderCost: rt?.orderCost ?? p.allocatedCost,
    leverage: p.leverage,
    marginMode: p.marginMode === 'Cross' ? 'cross' : 'isolated',
    stopLossPct: rt?.stopLossPct ?? 0,
    stopPrice: rt?.stopPrice ?? p.stopLoss,
    targets,
    trailingEnabled: rt?.trailingEnabled ?? false,
    trailingPct: rt?.trailingPct ?? 0,
    bestPrice: rt?.bestPrice ?? p.markPrice,
    trailingStop: rt?.trailingStop ?? null,
    exits,
    realizedPnl: realized,
    status,
    openedAt: rt?.openedAtMs ?? dayTimeToMs(p.openedAt),
    closedAt: extra?.closedAt,
    closeReason: extra?.closeReason
  };
}

/** Completed trades come from the same records Trade History reads. */
export function tradeToView(state: DemoState, t: TradeRecord): HoldingView {
  return positionToView(state, { ...t.snapshot, accountId: t.accountId }, { status: 'closed', closedAt: t.exitAt, closeReason: t.exitReason, gross: t.gross, fees: t.commissions });
}

/** Migrated holdings saved before accounts existed: shown, valued and exited, never counted in balances. */
export function migratedToView(p: HoldingPosition, price: number | undefined): HoldingView {
  return { ...p, kind: 'migrated', accountId: null, accountLabel: 'Unassigned — migrated', fees: 0, currentPrice: p.status === 'open' ? price : undefined };
}

export function unrealizedOf(v: HoldingView): number {
  if (v.status !== 'open' || !v.currentPrice) return 0;
  return (v.side === 'long' ? v.currentPrice - v.entryPrice : v.entryPrice - v.currentPrice) * v.remainingQty;
}