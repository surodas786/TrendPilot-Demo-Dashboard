import { CLOSE_SLIPPAGE_PCT } from '../../data/mockData';
import { simulatedAtr } from '../../data/exitPlans';
import { instrumentSpecs } from '../../data/strategyCatalog';
import { round2 } from '../../utils/accountMath';
import { formatClock } from '../../utils/clock';
import { computeExitPreview, floorToStep, roundPrice } from '../../utils/exitPlanMath';
import { MODE_LABELS, planLabel } from '../../utils/exitPlanText';
import { formatNumber, formatQuantity } from '../../utils/format';
import { isWorking, makeOrder, remainingQty, roundQty } from '../../utils/orders';
import { computeOrderPreview } from '../../utils/riskEngine';
import { executionReducer } from '../executionReducer';
import { findDelivery, makeActivity, makeNotification, nextSignalId, patchDelivery } from './signalHelpers';
import type { DemoState } from '../demoReducer';
import type { CentralSignal, Delivery, SignalOrderContext } from '../../types/signals';
import type { ExitPlan } from '../../types/exitPlan';
import type { OrderRecord } from '../../types/execution';
import type { Subscription } from '../../types/strategy';
import type { DemoAccount, Direction, Position } from '../../types/trading';

interface OpenArgs {
  sub: Subscription;
  plan: ExitPlan;
  account: DemoAccount;
  pair: string;
  direction: Direction;
  signalId: string;
  positionId: string;
}

/** Simulated entry ATR; a named demonstration may fix it (e.g. 200 USDT for the presentation). */
export function atrFor(s: DemoState, pair: string): number {
  return s.scenarioOverrides?.atr[pair] ?? simulatedAtr[pair];
}

const dirWord = (d: Direction) => d === 'long' ? 'Long' : 'Short';
const basisLabel = (plan: ExitPlan) => plan.config.triggerBasis === 'last' ? 'Last price' : 'Mark price';

/**
 * Opens (or grows) a paper position from an actual entry fill. Exits are calculated from the
 * actual average fill; protection is only labelled confirmed once its stop record rests.
 */
export function openFromFill(s: DemoState, a: OpenArgs, qty: number, price: number, at: number, protectionFails: boolean): {state: DemoState;protectionOk: boolean;} {
  const spec = instrumentSpecs[a.pair];
  const cfg = a.plan.config;
  const preview = computeExitPreview({
    config: cfg,
    pair: a.pair,
    direction: a.direction,
    entryPrice: price,
    atr: atrFor(s, a.pair),
    orderCost: a.sub.orderCost,
    leverage: a.sub.leverage,
    feeRatePct: s.simFeeRatePct,
    quantityOverride: qty
  });
  const stop = preview.stopPrice;
  const fee = round2(price * qty * (s.simFeeRatePct / 100));
  const fmt = (v: number) => formatNumber(v, spec.priceDecimals);
  const q = (v: number) => formatQuantity(v, spec.quantityDecimals, spec.baseAsset);
  const protectedOk = !protectionFails && stop !== null;
  const confirmAt = at + 220;
  const trailingState =
  cfg.mode === 'fixed' ?
  'Not used by this plan' :
  cfg.mode === 'trailing' ?
  `Inactive · activates at ${preview.activationPrice !== null ? fmt(preview.activationPrice) : '—'}` :
  `Inactive · starts after partial at ${preview.partial ? fmt(preview.partial.price) : '—'}`;

  const position: Position = {
    id: a.positionId,
    accountId: a.account.id,
    exchangeId: a.account.exchangeId,
    pair: a.pair,
    baseAsset: spec.baseAsset,
    direction: a.direction,
    strategyId: a.sub.strategyId,
    quantity: qty,
    closedQuantity: 0,
    allocatedCost: round2(price * qty / a.sub.leverage),
    leverage: a.sub.leverage,
    entryPrice: price,
    markPrice: price,
    stopLoss: stop ?? Number.NaN,
    takeProfit: preview.targetPrice ?? preview.partial?.price ?? Number.NaN,
    initialStop: stop,
    trailingState,
    protection: protectedOk ? 'protected' : 'unprotected',
    marginMode: 'Isolated',
    triggerBasis: `${basisLabel(a.plan)} (simulated)`,
    openedAt: formatClock(at),
    priceDecimals: spec.priceDecimals,
    quantityDecimals: spec.quantityDecimals,
    managed: true,
    strategyVersion: a.sub.version,
    subscriptionLabel: a.sub.label,
    exitSnapshot: {
      planLabel: planLabel(a.plan),
      mode: MODE_LABELS[cfg.mode],
      partialTarget: preview.partial ? `${fmt(preview.partial.price)} (${preview.partial.r.toFixed(2)}R)` : null,
      closePct: cfg.mode === 'partial-trailing' ? cfg.closePct : null,
      trailing: null,
      bestPrice: null,
      oppositeExit: cfg.closeOnOpposite
    },
    sourceSignalId: a.signalId,
    subscriptionId: a.sub.id,
    exitRuntime: {
      config: { ...cfg },
      planId: a.plan.id,
      rDistance: preview.stopDistance ?? 0,
      best: price,
      trailActive: false,
      partialDone: false,
      partialPrice: preview.partial?.price ?? null,
      activationPrice: preview.activationPrice,
      targetPrice: preview.targetPrice
    }
  };

  const common = { accountId: a.account.id, positionId: a.positionId, pair: a.pair, baseAsset: spec.baseAsset, priceDecimals: spec.priceDecimals, quantityDecimals: spec.quantityDecimals, createdAt: at + 40 };
  const exitSide = a.direction === 'long' ? 'Sell' : 'Buy';
  const orders: OrderRecord[] = [
  makeOrder({
    ...common,
    id: nextSignalId('ORD-SL', at),
    purpose: 'stop-loss',
    side: exitSide,
    type: 'Stop market',
    requestedQty: qty,
    price: stop,
    state: protectedOk ? 'submitted' : 'rejected',
    updatedAt: confirmAt,
    triggerBasis: basisLabel(a.plan),
    note: protectedOk ? 'Resting stop confirmed (simulated)' : 'Protective stop rejected by the simulated venue'
  })];

  if (protectedOk && cfg.mode === 'fixed' && preview.targetPrice !== null) {
    orders.push(makeOrder({ ...common, id: nextSignalId('ORD-TP', at), purpose: 'take-profit', side: exitSide, type: 'Limit · target', requestedQty: qty, price: preview.targetPrice, state: 'submitted', updatedAt: confirmAt }));
  }
  if (protectedOk && cfg.mode === 'partial-trailing' && preview.partial) {
    const pq = floorToStep(qty * (cfg.closePct ?? 0) / 100, spec);
    if (pq >= spec.minQuantity) {
      orders.push(makeOrder({ ...common, id: nextSignalId('ORD-TP', at), purpose: 'take-profit', side: exitSide, type: 'Limit · partial', requestedQty: pq, price: preview.partial.price, state: 'submitted', updatedAt: confirmAt }));
    }
  }

  const protectionDetail = protectedOk ?
  `Stop ${fmt(stop as number)}${preview.targetPrice !== null ? ` · Target ${fmt(preview.targetPrice)}` : ''}${preview.partial ? ` · Partial ${fmt(preview.partial.price)}` : ''} · ${q(qty)}` :
  'No resting stop — recovery started';
  const ledgerFee = {
    id: nextSignalId('led', at),
    kind: 'entry-fee' as const,
    positionId: a.positionId,
    at,
    closedAt: formatClock(at),
    accountId: a.account.id,
    strategyId: a.sub.strategyId,
    pair: a.pair,
    direction: a.direction,
    grossPnl: 0,
    commission: fee,
    fundingPaid: 0,
    fundingReceived: 0
  };
  const base = { accountId: a.account.id, strategyId: a.sub.strategyId, pair: a.pair, positionId: a.positionId };

  return {
    protectionOk: protectedOk,
    state: {
      ...s,
      positions: [...s.positions, position],
      orders: [...s.orders, ...orders],
      closedTrades: [...s.closedTrades, ledgerFee],
      activity: [
      makeActivity(base, confirmAt, protectedOk ? 'protection' : 'reject', protectedOk ? 'Protective stop confirmed' : 'Protective stop rejected', protectionDetail),
      makeActivity(base, at, 'entry', 'Paper entry filled', `${dirWord(a.direction)} ${q(qty)} at ${fmt(price)} · ${a.sub.leverage}× · fee ${formatNumber(fee)} · signal ${a.signalId}`),
      ...s.activity],

      notifications: [
      makeNotification(s, a.account.id, at, 'Paper entry filled', `${a.pair} ${dirWord(a.direction)} · ${a.account.name} · ${q(qty)} at ${fmt(price)}`, 'success'),
      ...s.notifications]

    }
  };
}

/** Recovery after a protection failure: block further fills, cancel the remainder, close exposure. */
export function recoverUnprotected(s: DemoState, positionId: string, accountId: string, at: number): {state: DemoState;notes: string[];exposed: boolean;} {
  const notes = ['Protective stop rejected — further entry fills blocked'];
  let state = s;
  const working = state.orders.find((o) => o.positionId === positionId && o.purpose === 'entry' && isWorking(o));
  if (working) {
    state = { ...state, orders: state.orders.map((o) => o.id === working.id ? { ...o, state: 'cancelled', updatedAt: at, note: 'Remainder cancelled after protection failure' } : o) };
    notes.push(`Unfilled remainder ${formatNumber(remainingQty(working), working.quantityDecimals)} ${working.baseAsset} cancelled · reservation released`);
  }
  const p = state.positions.find((x) => x.id === positionId);
  if (!p) return { state, notes, exposed: false };
  const requestId = `RECOVERY-${positionId}`;
  state = executionReducer(state, { type: 'submitClose', requestId, accountId, kind: 'full', items: [{ positionId, qty: p.quantity }], at: at + 300 });
  const item = state.closeRequests.find((r) => r.id === requestId)?.items[0];
  const exposed = !item || item.state !== 'filled';
  if (!exposed && item) {
    notes.push(`Exposed ${formatQuantity(item.filledQty, item.quantityDecimals, item.baseAsset)} closed at ${formatNumber(item.fillPrice ?? 0, item.priceDecimals)} with a reduce-only order`);
    state = { ...state, tradeRecords: state.tradeRecords.map((t) => t.positionId === positionId ? { ...t, exitReason: 'Recovery close after protection failure' } : t) };
  } else {
    notes.push(`Recovery close ${item?.state ?? 'not submitted'}: ${item?.reason ?? 'no result'} — EXPOSURE REMAINS UNPROTECTED`);
    state = {
      ...state,
      notifications: [makeNotification(state, accountId, at, 'Critical: unprotected paper exposure', `${p.pair} ${dirWord(p.direction)} · protection failed and recovery close did not complete`, 'warning'), ...state.notifications]
    };
  }
  return { state, notes, exposed };
}

export interface EntryArgs {
  central: CentralSignal;
  delivery: Delivery;
  sub: Subscription;
  plan: ExitPlan;
  account: DemoAccount;
  direction: Direction;
}

/** Simulated entry submission. Margin is reserved by the order record before submission. */
export function executeEntry(s: DemoState, e: EntryArgs): {state: DemoState;delivery: Delivery;} {
  const { central, sub, plan, account, direction } = e;
  const pair = central.pair;
  const spec = instrumentSpecs[pair];
  const behavior = s.entryBehavior[account.id] ?? 'fill';
  const sign = direction === 'long' ? 1 : -1;
  const at0 = e.delivery.evaluatedAt;
  const submittedAt = at0 + 40;
  const ackAt = at0 + 160;
  const fillAt = at0 + 340;
  const slipPct = s.scenarioOverrides?.zeroSlippage ? 0 : CLOSE_SLIPPAGE_PCT;
  const fill = roundPrice(central.referencePrice * (1 + sign * slipPct / 100), spec.priceDecimals);
  const sized = computeOrderPreview({ pair, direction, orderCost: sub.orderCost, leverage: sub.leverage, feeRatePct: s.simFeeRatePct, price: central.referencePrice, availableMargin: Number.MAX_SAFE_INTEGER, pendingMargin: 0, reserve: 0 });
  const qty = sized.roundedQuantity;
  const ref = computeExitPreview({ config: plan.config, pair, direction, entryPrice: central.referencePrice, atr: atrFor(s, pair), orderCost: sub.orderCost, leverage: sub.leverage, feeRatePct: s.simFeeRatePct });
  const positionId = nextSignalId('pos-sig', at0);
  const ctx: SignalOrderContext = { centralId: central.id, deliveryId: e.delivery.id, subscriptionId: sub.id, planId: plan.id, positionId };
  const feeOf = (q: number) => round2(fill * q * (s.simFeeRatePct / 100));
  const q = (v: number) => formatQuantity(v, spec.quantityDecimals, spec.baseAsset);
  const entryOrder = makeOrder({
    id: nextSignalId('ORD-EN', at0),
    accountId: account.id,
    positionId,
    pair,
    baseAsset: spec.baseAsset,
    purpose: 'entry',
    side: direction === 'long' ? 'Buy' : 'Sell',
    type: 'Market',
    requestedQty: qty,
    price: central.referencePrice,
    state: 'submitted',
    createdAt: submittedAt,
    priceDecimals: spec.priceDecimals,
    quantityDecimals: spec.quantityDecimals,
    leverage: sub.leverage,
    stopRisk: ref.grossLossToStop,
    signalContext: ctx
  });
  const args: OpenArgs = { sub, plan, account, pair, direction, signalId: central.signalId, positionId };
  const delivery: Delivery = { ...e.delivery, submittedAt, orderIds: [entryOrder.id] };

  if (behavior === 'reject') {
    const state = { ...s, orders: [...s.orders, { ...entryOrder, state: 'rejected' as const, updatedAt: ackAt, note: 'Rejected by the simulated venue · reservation released' }] };
    return { state, delivery: { ...delivery, ackAt, state: 'failed', reason: 'Simulated venue rejected the entry order — reservation released, no position opened', link: { to: '/positions-orders?tab=orders', label: 'View order records' } } };
  }
  if (behavior === 'unknown') {
    const state = { ...s, orders: [...s.orders, { ...entryOrder, state: 'unknown' as const, updatedAt: submittedAt, reconcileFillPrice: fill, note: 'Submitted · no acknowledgement — reconcile before any retry' }] };
    return {
      state,
      delivery: { ...delivery, state: 'unknown', reason: 'Submission outcome unknown — margin stays reserved and no retry is sent until the order is reconciled', link: { to: '/positions-orders?tab=orders', label: 'Reconcile in Open Orders' } }
    };
  }

  const fq = behavior === 'partial' ? floorToStep(qty * 0.5, spec) : qty;
  const filledOrder: OrderRecord = {
    ...entryOrder,
    state: fq < qty ? 'partially-filled' : 'filled',
    filledQty: fq,
    updatedAt: fillAt,
    fills: [{ id: nextSignalId('FIL', fillAt), at: fillAt, price: fill, quantity: fq, fee: feeOf(fq) }],
    note: fq < qty ? `Partially filled · remainder ${q(roundQty(qty - fq, spec.quantityDecimals))} working with margin reserved` : undefined
  };
  let state: DemoState = { ...s, orders: [...s.orders, filledOrder] };
  const opened = openFromFill(state, args, fq, fill, fillAt, behavior === 'protection-fail');
  state = opened.state;
  const filledDelivery: Delivery = {
    ...delivery,
    ackAt,
    firstFillAt: fillAt,
    finalFillAt: fq < qty ? undefined : fillAt,
    positionId,
    state: fq < qty ? 'partially-filled' : 'executed',
    reason: fq < qty ? `Filled ${q(fq)} of ${q(qty)} at ${formatNumber(fill, spec.priceDecimals)} · filled quantity protected · remainder working` : `Filled ${q(qty)} at ${formatNumber(fill, spec.priceDecimals)}`,
    protection: opened.protectionOk ? 'Protection confirmed' : 'Protection failed',
    link: { to: '/positions-orders', label: 'View position' }
  };
  if (opened.protectionOk) return { state, delivery: filledDelivery };

  const rec = recoverUnprotected(state, positionId, account.id, fillAt);
  return {
    state: rec.state,
    delivery: { ...filledDelivery, protection: rec.exposed ? 'Protection failed — exposure remains' : 'Protection failed — recovered by closing', recovery: rec.notes }
  };
}

/** Reconciles an unknown signal entry order. Never resubmits — reveals the deterministic outcome. */
export function reconcileSignalEntry(s: DemoState, orderId: string, at: number): DemoState {
  const o = s.orders.find((x) => x.id === orderId);
  const ctx = o?.signalContext;
  if (!o || !ctx || o.state !== 'unknown' || o.reconcileFillPrice === undefined) return s;
  const sub = s.subscriptions.find((x) => x.id === ctx.subscriptionId);
  const plan = s.exitPlans.find((x) => x.id === ctx.planId);
  const account = s.accounts.find((x) => x.id === o.accountId);
  const central = s.centralSignals.find((c) => c.id === ctx.centralId);
  if (!sub || !plan || !account || !central) return s;
  const fill = o.reconcileFillPrice;
  const fee = round2(fill * o.requestedQty * (s.simFeeRatePct / 100));
  let state: DemoState = {
    ...s,
    orders: s.orders.map((x) => x.id === orderId ? { ...x, state: 'filled', filledQty: x.requestedQty, updatedAt: at, note: 'Reconciled — found filled', fills: [{ id: nextSignalId('FIL', at), at, price: fill, quantity: x.requestedQty, fee }] } : x)
  };
  const direction: Direction = o.side === 'Buy' ? 'long' : 'short';
  const opened = openFromFill(state, { sub, plan, account, pair: o.pair, direction, signalId: central.signalId, positionId: ctx.positionId }, o.requestedQty, fill, at, false);
  state = opened.state;
  return patchDelivery(state, ctx.centralId, ctx.deliveryId, {
    state: 'executed',
    ackAt: at,
    firstFillAt: at,
    finalFillAt: at,
    positionId: ctx.positionId,
    reason: `Reconciled — entry found filled ${formatQuantity(o.requestedQty, o.quantityDecimals, o.baseAsset)} at ${formatNumber(fill, o.priceDecimals)}; no retry was sent`,
    protection: 'Protection confirmed',
    link: { to: '/positions-orders', label: 'View position' }
  });
}

/** Fills the working remainder of a partially filled signal entry and resizes protection. */
export function fillSignalEntryRemainder(s: DemoState, orderId: string, at: number): DemoState {
  const o = s.orders.find((x) => x.id === orderId);
  const ctx = o?.signalContext;
  if (!o || !ctx || o.state !== 'partially-filled') return s;
  const p = s.positions.find((x) => x.id === ctx.positionId);
  const stopOk = s.orders.some((x) => x.positionId === ctx.positionId && x.purpose === 'stop-loss' && (x.state === 'submitted' || x.state === 'partially-filled'));
  if (!p || !stopOk) return s;
  const rest = remainingQty(o);
  const price = o.fills[0]?.price ?? o.price ?? p.entryPrice;
  const fee = round2(price * rest * (s.simFeeRatePct / 100));
  const newQty = roundQty(p.quantity + rest, p.quantityDecimals);
  const avg = Number(((p.entryPrice * p.quantity + price * rest) / newQty).toFixed(p.priceDecimals + 2));
  const spec = instrumentSpecs[p.pair];
  const cfg = p.exitRuntime?.config;
  const partialQty = cfg?.mode === 'partial-trailing' && cfg.closePct ? floorToStep(newQty * cfg.closePct / 100, spec) : null;
  const q = (v: number) => formatQuantity(v, p.quantityDecimals, p.baseAsset);
  const state: DemoState = {
    ...s,
    positions: s.positions.map((x) => x.id === p.id ? { ...x, quantity: newQty, entryPrice: avg, allocatedCost: round2(x.allocatedCost + price * rest / x.leverage) } : x),
    orders: s.orders.map((x) => {
      if (x.id === orderId) return { ...x, state: 'filled', filledQty: x.requestedQty, updatedAt: at, note: undefined, fills: [...x.fills, { id: nextSignalId('FIL', at), at, price, quantity: rest, fee }] };
      if (x.positionId === p.id && isWorking(x) && x.purpose === 'stop-loss') return { ...x, requestedQty: newQty, updatedAt: at, note: `Resized to ${q(newQty)} after remaining entry fill` };
      if (x.positionId === p.id && isWorking(x) && x.purpose === 'take-profit') return { ...x, requestedQty: partialQty ?? newQty, updatedAt: at, note: 'Resized after remaining entry fill' };
      return x;
    }),
    closedTrades: [...s.closedTrades, { id: nextSignalId('led', at), kind: 'entry-fee', positionId: p.id, at, closedAt: formatClock(at), accountId: p.accountId, strategyId: p.strategyId, pair: p.pair, direction: p.direction, grossPnl: 0, commission: fee, fundingPaid: 0, fundingReceived: 0 }],
    activity: [makeActivity({ ...p, positionId: p.id }, at, 'protection', 'Remaining entry filled · protection resized', `+${q(rest)} at ${formatNumber(price, p.priceDecimals)} · stop now covers ${q(newQty)}`), ...s.activity]
  };
  const d = findDelivery(state, ctx.centralId, ctx.deliveryId);
  return patchDelivery(state, ctx.centralId, ctx.deliveryId, {
    state: 'executed',
    finalFillAt: at,
    reason: `Filled ${q(newQty)} in two fills at ${formatNumber(price, p.priceDecimals)} · protection resized to the full quantity`,
    protection: d?.protection ?? 'Protection confirmed'
  });
}