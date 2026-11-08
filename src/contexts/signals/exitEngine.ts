import { round2 } from '../../utils/accountMath';
import { estimateBreakeven, roundPrice, trailDistanceAt } from '../../utils/exitPlanMath';
import { formatNumber, formatQuantity } from '../../utils/format';
import { isWorking, remainingQty, workingStop } from '../../utils/orders';
import { applyCloseFill } from '../executionReducer';
import { makeActivity, nextSignalId } from './signalHelpers';
import type { DemoState } from '../demoReducer';
import type { Position } from '../../types/trading';

/** Positions the shared paper price controller affects: managed positions opened through the signal flow. */
export function priceControlledPositions(state: DemoState, pair: string): Position[] {
  return state.positions.filter((p) => p.pair === pair && p.exitRuntime && p.managed !== false);
}

function fillOrder(state: DemoState, orderId: string, qty: number, price: number, at: number): DemoState {
  return {
    ...state,
    orders: state.orders.map((o) =>
    o.id === orderId ?
    { ...o, state: 'filled', triggerState: o.triggerState ? 'triggered' : null, filledQty: o.filledQty + qty, updatedAt: at, fills: [...o.fills, { id: nextSignalId('FIL', at), at, price, quantity: qty, fee: round2(price * qty * (state.simFeeRatePct / 100)) }] } :
    o
    )
  };
}

function moveStop(state: DemoState, p: Position, stopId: string, newStop: number, at: number, title: string): DemoState {
  const fmt = (v: number) => formatNumber(v, p.priceDecimals);
  const prev = state.orders.find((o) => o.id === stopId)?.price;
  return {
    ...state,
    positions: state.positions.map((x) => x.id === p.id ? { ...x, stopLoss: newStop } : x),
    orders: state.orders.map((o) => o.id === stopId ? { ...o, price: newStop, updatedAt: at, note: `${title} (simulated)` } : o),
    activity: [makeActivity({ ...p, positionId: p.id }, at, 'trailing', title, `Stop ${prev !== undefined && prev !== null ? fmt(prev) : '—'} → ${fmt(newStop)} · initial stop and R unchanged`), ...state.activity]
  };
}

/**
 * Advances one simulated price for a pair and runs the saved exit rules of every
 * signal-created position on it through the shared order, fill and accounting logic.
 */
export function applyPaperPrice(state: DemoState, pair: string, price: number, at: number): DemoState {
  let s: DemoState = { ...state, paperPrices: { ...state.paperPrices, [pair]: price } };
  for (const original of priceControlledPositions(s, pair)) {
    let p = s.positions.find((x) => x.id === original.id);
    if (!p || !p.exitRuntime) continue;
    const rt = p.exitRuntime;
    const sign = p.direction === 'long' ? 1 : -1;
    const fmt = (v: number) => formatNumber(v, p!.priceDecimals);
    const best = sign * (price - rt.best) > 0 ? price : rt.best;
    s = { ...s, positions: s.positions.map((x) => x.id === p!.id ? { ...x, markPrice: price, exitRuntime: { ...rt, best } } : x) };
    p = s.positions.find((x) => x.id === original.id)!;
    let runtime = p.exitRuntime!;
    const cfg = runtime.config;

    // Fixed target
    if (cfg.mode === 'fixed' && runtime.targetPrice !== null && sign * (price - runtime.targetPrice) >= 0) {
      const tp = s.orders.find((o) => o.positionId === p!.id && o.purpose === 'take-profit' && isWorking(o));
      if (tp) {
        s = fillOrder(s, tp.id, p.quantity, runtime.targetPrice, at);
        s = applyCloseFill(s, p.id, p.quantity, runtime.targetPrice, at, 'Take profit');
        continue;
      }
    }

    // Partial profit, then breakeven and trailing
    if (cfg.mode === 'partial-trailing' && !runtime.partialDone && runtime.partialPrice !== null && sign * (price - runtime.partialPrice) >= 0) {
      const tp = s.orders.find((o) => o.positionId === p!.id && o.purpose === 'take-profit' && isWorking(o));
      if (tp) {
        const qty = remainingQty(tp);
        s = fillOrder(s, tp.id, qty, runtime.partialPrice, at);
        s = applyCloseFill(s, p.id, qty, runtime.partialPrice, at, 'Partial take profit');
        p = s.positions.find((x) => x.id === original.id);
        if (!p) continue;
        runtime = { ...runtime, partialDone: true, trailActive: true };
        s = { ...s, positions: s.positions.map((x) => x.id === p!.id ? { ...x, exitRuntime: runtime, trailingState: `Active · tracking from ${fmt(runtime.best)}` } : x) };
        const stop = workingStop(s.orders, p.id);
        if (cfg.moveToBreakeven && stop && stop.price !== null) {
          const f = s.simFeeRatePct / 100;
          const be = roundPrice(estimateBreakeven(p.direction, p.entryPrice, p.quantity, round2(p.entryPrice * p.quantity * f), f), p.priceDecimals);
          if (sign * (be - stop.price) > 0 && sign * (price - be) > 0) s = moveStop(s, p, stop.id, be, at, 'Stop moved to estimated breakeven');
        }
        p = s.positions.find((x) => x.id === original.id)!;
      }
    }

    // Trailing activation
    if (cfg.mode === 'trailing' && !runtime.trailActive && runtime.activationPrice !== null && sign * (price - runtime.activationPrice) >= 0) {
      runtime = { ...runtime, trailActive: true };
      s = {
        ...s,
        positions: s.positions.map((x) => x.id === p!.id ? { ...x, exitRuntime: runtime, trailingState: `Active · tracking from ${fmt(runtime.best)}` } : x),
        activity: [makeActivity({ ...p, positionId: p.id }, at, 'trailing', 'Trailing stop activated', `Activation ${fmt(runtime.activationPrice as number)} reached at ${fmt(price)}`), ...s.activity]
      };
      p = s.positions.find((x) => x.id === original.id)!;
    }

    // Trailing tightening (only ever more protective)
    if (runtime.trailActive) {
      const stop = workingStop(s.orders, p.id);
      const dist = trailDistanceAt(cfg, runtime.best, runtime.rDistance);
      if (stop && stop.price !== null && dist !== null) {
        const candidate = roundPrice(runtime.best - sign * dist, p.priceDecimals);
        if (sign * (candidate - stop.price) > 0 && sign * (price - candidate) > 0) s = moveStop(s, p, stop.id, candidate, at, 'Trailing stop tightened');
        s = { ...s, positions: s.positions.map((x) => x.id === original.id ? { ...x, trailingState: `Active · best ${fmt(runtime.best)}` } : x) };
      }
      p = s.positions.find((x) => x.id === original.id)!;
    }

    // Stop trigger — fills at the update price (gaps fill beyond the trigger).
    const stop = workingStop(s.orders, p.id);
    if (stop && stop.price !== null && sign * (price - stop.price) <= 0) {
      const qty = Math.min(remainingQty(stop), p.quantity);
      const reason = runtime.trailActive ? 'Trailing stop' : 'Stop loss';
      s = fillOrder(s, stop.id, qty, price, at);
      s = applyCloseFill(s, p.id, qty, price, at, reason);
      s = {
        ...s,
        activity: [makeActivity({ ...p, positionId: p.id }, at, 'stop-loss', `${reason} triggered`, `Trigger ${fmt(stop.price)} · fill ${fmt(price)} · ${formatQuantity(qty, p.quantityDecimals, p.baseAsset)}`), ...s.activity]
      };
    }
  }
  return s;
}