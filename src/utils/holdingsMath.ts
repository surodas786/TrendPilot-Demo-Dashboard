import type { ExitFill, HoldingPosition, PositionSide } from '../types/holdings';
import type { StrategyPackage } from '../types/platform';
import type { TokenBlock } from '../types/tradeSettings';

export const EPS = 1e-12;
/** Applies only to holdings recorded before fees were modeled (migrated, gross only). */
export const GROSS_NOTE = 'Recorded as gross P&L before fees and slippage were modeled.';
export const MODEL_NOTE = 'USDT-linear model: quantity = order cost × leverage ÷ fill price. Contract-size rounding and funding are not applied to token-block entries.';

/** Directional gross P&L for a quantity. */
export function pnlFor(side: PositionSide, entry: number, exit: number, qty: number): number {
  return (side === 'long' ? exit - entry : entry - exit) * qty;
}

export function unrealized(p: HoldingPosition, price: number | undefined): number {
  if (p.status !== 'open' || !price) return 0;
  return pnlFor(p.side, p.entryPrice, price, p.remainingQty);
}

const fav = (side: PositionSide, entry: number, pct: number) => side === 'long' ? entry * (1 + pct / 100) : entry * (1 - pct / 100);
const adv = (side: PositionSide, entry: number, pct: number) => side === 'long' ? entry * (1 - pct / 100) : entry * (1 + pct / 100);

function trailFrom(side: PositionSide, best: number, pct: number): number {
  return adv(side, best, pct);
}

/** Build a position from a block's CURRENT settings; values are frozen from here on. */
export function openPosition(args: {id: string;block: TokenBlock;pkg: StrategyPackage;side: PositionSide;price: number;at: number;receiptId: string;signalId: string;}): HoldingPosition {
  const { block: b, side, price } = args;
  const qty = b.orderCost * b.leverage / price;
  return {
    id: args.id,
    subscriberId: b.subscriberId,
    blockId: b.id,
    mode: b.mode,
    symbol: b.symbol,
    side,
    packageId: args.pkg.id,
    packageName: args.pkg.name,
    receiptId: args.receiptId,
    signalId: args.signalId,
    entryPrice: price,
    originalQty: qty,
    remainingQty: qty,
    orderCost: b.orderCost,
    leverage: b.leverage,
    marginMode: b.marginMode,
    stopLossPct: b.stopLossPct,
    stopPrice: adv(side, price, b.stopLossPct),
    targets: b.takeProfits.map((t) => ({ movePct: t.movePct, closePct: t.closePct, price: fav(side, price, t.movePct), state: 'open' })),
    trailingEnabled: b.trailingEnabled,
    trailingPct: b.trailingPct,
    bestPrice: price,
    trailingStop: b.trailingEnabled ? trailFrom(side, price, b.trailingPct) : null,
    exits: [],
    realizedPnl: 0,
    status: 'open',
    openedAt: args.at
  };
}

let fillSeq = 0;
function fill(p: HoldingPosition, price: number, qty: number, reason: string, at: number, receiptId?: string): ExitFill {
  fillSeq += 1;
  return { id: `${p.id}-x${p.exits.length + 1}-${fillSeq}`, at, price, qty, pnl: pnlFor(p.side, p.entryPrice, price, qty), reason, receiptId };
}

/** Close whatever remains, once. A full close cancels remaining simulated exits. */
export function closeRemaining(p: HoldingPosition, price: number, reason: string, at: number, receiptId?: string): HoldingPosition {
  if (p.status !== 'open' || p.remainingQty <= EPS) return p;
  const f = fill(p, price, p.remainingQty, reason, at, receiptId);
  return {
    ...p,
    remainingQty: 0,
    exits: [...p.exits, f],
    realizedPnl: p.realizedPnl + f.pnl,
    targets: p.targets.map((t) => t.state === 'open' ? { ...t, state: 'cancelled' } : t),
    status: 'closed',
    closedAt: at,
    closeReason: reason
  };
}

/**
 * Apply one price update. Uses levels from before this update for stops, then
 * fills crossed targets in order, then ratchets the trailing stop. No intratick path is assumed.
 */
export function applyPrice(p: HoldingPosition, price: number, at: number): HoldingPosition {
  if (p.status !== 'open') return p;
  const long = p.side === 'long';
  const hitStop = long ? price <= p.stopPrice : price >= p.stopPrice;
  const hitTrail = p.trailingStop !== null && (long ? price <= p.trailingStop : price >= p.trailingStop);
  if (hitStop || hitTrail) {
    // Whichever level is more protective was the one reached first.
    const trailTighter = hitTrail && (!hitStop || (long ? p.trailingStop! >= p.stopPrice : p.trailingStop! <= p.stopPrice));
    return closeRemaining(p, price, trailTighter ? 'Trailing stop' : 'Stop loss', at);
  }

  let next = p;
  p.targets.forEach((_, i) => {
    const t = next.targets[i];
    if (next.status !== 'open' || t.state !== 'open') return;
    const crossed = long ? price >= t.price : price <= t.price;
    if (!crossed) return;
    const isLast = next.targets.slice(i + 1).every((x) => x.state !== 'open');
    const want = isLast ? next.remainingQty : Math.min(next.remainingQty, p.originalQty * t.closePct / 100);
    const label = `Take profit ${i + 1}`;
    if (want >= next.remainingQty - EPS) {
      next = closeRemaining({ ...next, targets: next.targets.map((x, j) => j === i ? { ...x, state: 'filled' } : x) }, price, label, at);
      return;
    }
    const f = fill(next, price, want, label, at);
    next = { ...next, remainingQty: next.remainingQty - want, exits: [...next.exits, f], realizedPnl: next.realizedPnl + f.pnl, targets: next.targets.map((x, j) => j === i ? { ...x, state: 'filled' } : x) };
  });
  if (next.status !== 'open') return next;

  if (next.trailingEnabled) {
    const best = long ? Math.max(next.bestPrice, price) : Math.min(next.bestPrice, price);
    const level = trailFrom(next.side, best, next.trailingPct);
    const prev = next.trailingStop ?? level;
    next = { ...next, bestPrice: best, trailingStop: long ? Math.max(prev, level) : Math.min(prev, level) };
  }
  return next;
}

export function averageExit(p: HoldingPosition): number | null {
  const qty = p.exits.reduce((s, e) => s + e.qty, 0);
  return qty > 0 ? p.exits.reduce((s, e) => s + e.price * e.qty, 0) / qty : null;
}

export function formatQty(q: number): string {
  if (q === 0) return '0';
  if (q >= 1000) return q.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (q >= 1) return q.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return q.toLocaleString('en-US', { maximumSignificantDigits: 6 });
}