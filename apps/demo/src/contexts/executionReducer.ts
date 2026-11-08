import {
  accounts as seedAccounts,
  activityEvents as seedActivity,
  closedTrades as seedLedger,
  positions as seedPositions,
  signals as seedSignals } from
'../data/mockData';
import { seedOrders } from '../data/seedOrders';
import { ownerOf, secondUserAccounts } from '../data/demoUsers';
import { buildFixture, DEFAULT_ACCOUNT_SIM, FIXTURES } from '../data/demoFixtures';
import { closingFee, round2 } from '../utils/accountMath';
import { formatClock } from '../utils/clock';
import { assumedFillPrice, buildTradeRecord, floorToRules, grossFor, qtyRules, submissionBlockReason } from '../utils/execution';
import { formatNumber, formatQuantity, formatSigned } from '../utils/format';
import { isProtective, isWorking, makeOrder, remainingQty, roundQty, workingStop } from '../utils/orders';
import { appendAudit } from './strategyReducer';
import type { DemoState } from './demoReducer';
import type { AccountSim, CloseBehavior, CloseRequestItem, FixtureId, OrderRecord } from '../types/execution';
import type { ActivityEvent, Position } from '../types/trading';

export interface CloseItemInput {
  positionId: string;
  qty: number;
}

export type ExecutionAction =
{type: 'submitClose';requestId: string;accountId: string;kind: 'full' | 'partial' | 'all';items: CloseItemInput[];at: number;} |
{type: 'reconcileOrder';orderId: string;at: number;} |
{type: 'cancelEntryOrder';orderId: string;at: number;} |
{type: 'tightenStop';positionId: string;newStop: number;at: number;} |
{type: 'loadFixture';accountId: string;fixture: FixtureId;at: number;} |
{type: 'restoreAccount';accountId: string;at: number;};

const EXECUTION_ACTIONS = new Set(['submitClose', 'reconcileOrder', 'cancelEntryOrder', 'tightenStop', 'loadFixture', 'restoreAccount']);

export function isExecutionAction(action: {type: string;}): action is ExecutionAction {
  return EXECUTION_ACTIONS.has(action.type);
}

let seq = 0;
const nextId = (prefix: string, at: number) => {
  seq += 1;
  return `${prefix}-${at.toString(36).slice(-5).toUpperCase()}${seq}`;
};

export function simFor(state: DemoState, accountId: string): AccountSim {
  return state.accountSim[accountId] ?? DEFAULT_ACCOUNT_SIM;
}

function activity(p: Pick<Position, 'accountId' | 'strategyId' | 'pair' | 'id'>, at: number, kind: ActivityEvent['kind'], title: string, detail: string): ActivityEvent {
  return { id: nextId('act', at), kind, title, detail, accountId: p.accountId, strategyId: p.strategyId, pair: p.pair, time: formatClock(at), positionId: p.id };
}

const dirLabel = (p: Position) => p.direction === 'long' ? 'Long' : 'Short';

/**
 * Applies one closing fill. Positions, orders, the realized ledger, balances, risk usage and
 * history all derive from the resulting records, so every screen stays consistent.
 */
export function applyCloseFill(state: DemoState, positionId: string, qtyIn: number, price: number, at: number, reason: string): DemoState {
  const p = state.positions.find((x) => x.id === positionId);
  if (!p || qtyIn <= 0) return state;
  const qty = Math.min(qtyIn, p.quantity);
  const gross = grossFor(p, qty, price);
  const fee = closingFee(price, qty, state.simFeeRatePct);
  const remaining = roundQty(p.quantity - qty, p.quantityDecimals);
  const final = remaining <= 0;
  const time = formatClock(at);
  const ledger = [
  ...state.closedTrades,
  { id: nextId('led', at), kind: final ? 'final' as const : 'partial' as const, positionId: p.id, quantity: qty, fillPrice: price, at, closedAt: time, accountId: p.accountId, strategyId: p.strategyId, pair: p.pair, direction: p.direction, grossPnl: gross, commission: fee, fundingPaid: 0, fundingReceived: 0 }];

  const qtyText = formatQuantity(qty, p.quantityDecimals, p.baseAsset);
  const act = activity(p, at, final ? 'close' : 'exit', final ? 'Paper position closed' : 'Partial paper close filled', `${dirLabel(p)} ${qtyText} at ${formatNumber(price, p.priceDecimals)} · ${formatSigned(gross)} USDT gross · fee ${formatNumber(fee)}`);
  const owner = state.accounts.find((a) => a.id === p.accountId);
  const accountName = owner?.name ?? '';
  const userId = ownerOf(owner);

  if (final) {
    const exchangeId = p.exchangeId;
    return {
      ...state,
      positions: state.positions.filter((x) => x.id !== p.id),
      orders: state.orders.map((o) => o.positionId === p.id && isWorking(o) && o.purpose !== 'manual-close' ? { ...o, state: 'cancelled', updatedAt: at, note: 'Obsolete after full closure — cancelled' } : o),
      closedTrades: ledger,
      tradeRecords: [buildTradeRecord(p, ledger, at, reason, exchangeId), ...state.tradeRecords],
      activity: [act, ...state.activity],
      notifications: [{ id: nextId('ntf', at), title: 'Paper position closed', detail: `${p.pair} ${dirLabel(p)} · ${accountName} · ${formatSigned(gross)} USDT gross`, time, read: false, tone: 'success', userId }, ...state.notifications]
    };
  }
  return {
    ...state,
    positions: state.positions.map((x) => x.id === p.id ? { ...x, quantity: remaining, closedQuantity: roundQty(x.closedQuantity + qty, x.quantityDecimals) } : x),
    // Resize remaining protective orders so they never exceed the remaining exposure.
    orders: state.orders.map((o) =>
    o.positionId === p.id && isWorking(o) && isProtective(o) && remainingQty(o) > remaining ?
    { ...o, requestedQty: roundQty(o.filledQty + remaining, o.quantityDecimals), updatedAt: at, note: `Resized to remaining ${formatQuantity(remaining, p.quantityDecimals, p.baseAsset)}` } :
    o
    ),
    closedTrades: ledger,
    activity: [act, ...state.activity]
  };
}

function closeOrderFor(p: Position, qty: number, at: number, requestId: string): OrderRecord {
  return makeOrder({
    id: nextId('ORD-MC', at),
    accountId: p.accountId,
    positionId: p.id,
    pair: p.pair,
    baseAsset: p.baseAsset,
    purpose: 'manual-close',
    side: p.direction === 'long' ? 'Sell' : 'Buy',
    type: 'Market · reduce-only',
    requestedQty: qty,
    price: p.markPrice,
    state: 'pending-submission',
    createdAt: at,
    priceDecimals: p.priceDecimals,
    quantityDecimals: p.quantityDecimals,
    reduceOnly: true,
    closeRequestId: requestId
  });
}

function submitClose(state: DemoState, action: Extract<ExecutionAction, {type: 'submitClose';}>): DemoState {
  if (state.closeRequests.some((r) => r.id === action.requestId)) return state; // duplicate click
  const { at, requestId } = action;
  const account = state.accounts.find((a) => a.id === action.accountId);
  const block = submissionBlockReason(account);
  const sim = simFor(state, action.accountId);
  let s = state;
  const items: CloseRequestItem[] = [];

  for (const input of action.items) {
    const p = s.positions.find((x) => x.id === input.positionId);
    if (!p) continue;
    const base = { positionId: p.id, pair: p.pair, direction: p.direction, requestedQty: input.qty, referencePrice: p.markPrice, quantityDecimals: p.quantityDecimals, priceDecimals: p.priceDecimals, baseAsset: p.baseAsset };
    if (p.managed === false || input.qty <= 0 || input.qty > p.quantity + 1e-9) {
      items.push({ ...base, filledQty: 0, fillPrice: null, remainingQty: p.quantity, state: 'failed', trail: ['requested', 'failed'], reason: p.managed === false ? 'Unmanaged position — outside this action' : 'Quantity exceeds remaining exposure', orderId: null });
      continue;
    }
    const fill = assumedFillPrice(p);
    const order = closeOrderFor(p, input.qty, at, requestId);

    if (block) {
      s = { ...s, orders: [...s.orders, { ...order, state: 'rejected', note: `Not submitted — ${block}` }], activity: [activity(p, at, 'reject', 'Close request not submitted', block), ...s.activity] };
      items.push({ ...base, filledQty: 0, fillPrice: null, remainingQty: p.quantity, state: 'failed', trail: ['requested', 'failed'], reason: block, orderId: order.id });
      continue;
    }

    let behavior: CloseBehavior = sim.behaviorByPosition[p.id] ?? sim.closeBehavior;
    if (account?.scenario === 'sync-failed') behavior = 'unknown';
    const fee = (q: number) => closingFee(fill, q, s.simFeeRatePct);

    if (behavior === 'fill') {
      s = { ...s, orders: [...s.orders, { ...order, state: 'filled', filledQty: input.qty, updatedAt: at, fills: [{ id: nextId('FIL', at), at, price: fill, quantity: input.qty, fee: fee(input.qty) }] }] };
      s = applyCloseFill(s, p.id, input.qty, fill, at, action.kind === 'partial' ? 'Manual partial close' : 'Manual close');
      items.push({ ...base, filledQty: input.qty, fillPrice: fill, remainingQty: roundQty(p.quantity - input.qty, p.quantityDecimals), state: 'filled', trail: ['requested', 'submitted', 'filled'], orderId: order.id });
    } else if (behavior === 'partial-then-cancel') {
      const rules = qtyRules(p);
      let fq = floorToRules(input.qty * 0.5, rules);
      if (fq < rules.min) fq = 0;
      const rest = roundQty(input.qty - fq, p.quantityDecimals);
      s = {
        ...s,
        orders: [
        ...s.orders,
        { ...order, state: 'cancelled', filledQty: fq, updatedAt: at, note: `Partially filled; remaining ${formatQuantity(rest, p.quantityDecimals, p.baseAsset)} cancelled by simulated venue (fixture)`, fills: fq > 0 ? [{ id: nextId('FIL', at), at, price: fill, quantity: fq, fee: fee(fq) }] : [] }]

      };
      if (fq > 0) s = applyCloseFill(s, p.id, fq, fill, at, 'Manual close (partially filled)');
      s = { ...s, activity: [activity(p, at, 'reject', 'Closing order remainder cancelled', `${formatQuantity(rest, p.quantityDecimals, p.baseAsset)} not filled — position remains open for it`), ...s.activity] };
      items.push({ ...base, filledQty: fq, fillPrice: fq > 0 ? fill : null, remainingQty: roundQty(p.quantity - fq, p.quantityDecimals), state: 'partially-filled', trail: ['requested', 'submitted', 'partially-filled'], reason: `Filled ${formatQuantity(fq, p.quantityDecimals, p.baseAsset)}; remaining ${formatQuantity(rest, p.quantityDecimals, p.baseAsset)} cancelled — still open`, orderId: order.id });
    } else if (behavior === 'reject') {
      s = { ...s, orders: [...s.orders, { ...order, state: 'rejected', updatedAt: at, note: 'Simulated venue rejected the reduce-only order (fixture)' }], activity: [activity(p, at, 'reject', 'Closing order rejected', 'Simulated venue rejection · position unchanged'), ...s.activity] };
      items.push({ ...base, filledQty: 0, fillPrice: null, remainingQty: p.quantity, state: 'failed', trail: ['requested', 'submitted', 'failed'], reason: 'Rejected by simulated venue — position unchanged', orderId: order.id });
    } else {
      s = { ...s, orders: [...s.orders, { ...order, state: 'unknown', updatedAt: at, reconcileFillPrice: fill, note: 'Submitted · no acknowledgement received' }], activity: [activity(p, at, 'skip', 'Closing outcome unknown', 'No acknowledgement — reconcile before acting again'), ...s.activity] };
      items.push({ ...base, filledQty: 0, fillPrice: null, remainingQty: p.quantity, state: 'unknown', trail: ['requested', 'submitted', 'unknown'], reason: 'No acknowledgement — reconcile the simulated status. Do not resubmit.', orderId: order.id });
    }
  }

  const failed = items.filter((i) => i.state !== 'filled').length;
  return {
    ...s,
    closeRequests: [{ id: requestId, accountId: action.accountId, kind: action.kind, at, items }, ...s.closeRequests],
    auditLog: appendAudit(s, at, 'execution', action.accountId, `Paper close requested — ${action.kind === 'all' ? 'close all managed' : action.kind === 'partial' ? 'partial close' : 'full close'}`, `${items.length - failed} of ${items.length} filled${failed ? ` · ${failed} not completed` : ''}`, failed ? 'failure' : 'success')
  };
}

function reconcile(state: DemoState, orderId: string, at: number): DemoState {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order || order.state !== 'unknown') return state;
  const p = order.positionId ? state.positions.find((x) => x.id === order.positionId) : undefined;
  let s = state;
  let filled = false;
  if (p && order.reconcileFillPrice !== undefined) {
    const qty = Math.min(order.requestedQty, p.quantity);
    const fill = order.reconcileFillPrice;
    s = { ...s, orders: s.orders.map((o) => o.id === orderId ? { ...o, state: 'filled', filledQty: qty, updatedAt: at, note: 'Reconciled — found filled', fills: [{ id: nextId('FIL', at), at, price: fill, quantity: qty, fee: closingFee(fill, qty, s.simFeeRatePct) }] } : o) };
    s = applyCloseFill(s, p.id, qty, fill, at, 'Manual close (reconciled)');
    s = { ...s, activity: [activity(p, at, 'protection', 'Status reconciled', `Closing order ${orderId} found filled at ${formatNumber(fill, p.priceDecimals)}`), ...s.activity] };
    filled = true;
  } else {
    s = { ...s, orders: s.orders.map((o) => o.id === orderId ? { ...o, state: 'cancelled', updatedAt: at, note: 'Reconciled — no fill found' } : o) };
  }
  return {
    ...s,
    closeRequests: s.closeRequests.map((r) => ({
      ...r,
      items: r.items.map((i) =>
      i.orderId === orderId ?
      filled ?
      { ...i, state: 'filled', trail: [...i.trail, 'filled'], filledQty: i.requestedQty, fillPrice: order.reconcileFillPrice ?? null, remainingQty: roundQty(i.remainingQty - i.requestedQty, i.quantityDecimals), reason: 'Reconciled — found filled' } :
      { ...i, state: 'failed', trail: [...i.trail, 'failed'], reason: 'Reconciled — no fill found' } :
      i
      )
    })),
    auditLog: appendAudit(s, at, 'execution', order.accountId, 'Order status reconciled', `${orderId} · ${filled ? 'found filled' : 'no fill found'}`, filled ? 'success' : 'info')
  };
}

function cancelEntry(state: DemoState, orderId: string, at: number): DemoState {
  const o = state.orders.find((x) => x.id === orderId);
  if (!o || o.purpose !== 'entry' || !isWorking(o) || o.state === 'unknown') return state;
  const block = submissionBlockReason(state.accounts.find((a) => a.id === o.accountId));
  const p = { accountId: o.accountId, strategyId: 'supertrend-15m', pair: o.pair, id: '' };
  if (block) {
    return { ...state, activity: [{ ...activity(p, at, 'reject', 'Cancel request not submitted', `${orderId} · ${block} · reservation kept`), positionId: undefined }, ...state.activity] };
  }
  const released = o.price !== null && o.leverage ? round2(remainingQty(o) * o.price / o.leverage) : 0;
  return {
    ...state,
    orders: state.orders.map((x) => x.id === orderId ? { ...x, state: 'cancelled', updatedAt: at, note: `Cancellation confirmed · ${formatNumber(released)} USDT unfilled reservation released` } : x),
    activity: [{ ...activity(p, at, 'close', 'Entry order cancelled', `${o.pair} ${o.side} ${formatNumber(remainingQty(o), o.quantityDecimals)} ${o.baseAsset} · ${formatNumber(released)} USDT reservation released`), positionId: undefined }, ...state.activity],
    auditLog: appendAudit(state, at, 'execution', o.accountId, 'Working entry order cancelled', `${orderId} · ${formatNumber(released)} USDT released`, 'success')
  };
}

function tighten(state: DemoState, positionId: string, newStop: number, at: number): DemoState {
  const p = state.positions.find((x) => x.id === positionId);
  if (!p) return state;
  const current = workingStop(state.orders, p.id);
  if (!current || current.price === null) return state;
  const long = p.direction === 'long';
  const tighter = long ? newStop > current.price : newStop < current.price;
  const untriggered = long ? newStop < p.markPrice : newStop > p.markPrice;
  if (!tighter || !untriggered) return state;
  const block = submissionBlockReason(state.accounts.find((a) => a.id === p.accountId));
  const fails = Boolean(block) || simFor(state, p.accountId).protectionReplace === 'fail';
  const fmt = (v: number) => formatNumber(v, p.priceDecimals);
  const replacement = makeOrder({
    id: nextId('ORD-SL', at),
    accountId: p.accountId,
    positionId: p.id,
    pair: p.pair,
    baseAsset: p.baseAsset,
    purpose: 'stop-loss',
    side: current.side,
    type: 'Stop market · manual tighten',
    requestedQty: remainingQty(current),
    price: newStop,
    state: fails ? 'rejected' : 'submitted',
    createdAt: at,
    priceDecimals: p.priceDecimals,
    quantityDecimals: p.quantityDecimals,
    triggerBasis: current.triggerBasis,
    note: fails ? `Replacement rejected — previous stop ${fmt(current.price)} kept${block ? ` (${block})` : ' (fixture)'}` : `Replaces ${current.id}`
  });
  if (fails) {
    return {
      ...state,
      orders: [...state.orders, replacement],
      activity: [activity(p, at, 'reject', 'Stop replacement failed', `Proposed ${fmt(newStop)} rejected · confirmed stop ${fmt(current.price)} still active`), ...state.activity],
      auditLog: appendAudit(state, at, 'execution', p.accountId, 'Manual stop tighten failed', `${p.pair} ${dirLabel(p)} · ${fmt(current.price)} → ${fmt(newStop)} rejected · previous protection preserved`, 'failure')
    };
  }
  return {
    ...state,
    positions: state.positions.map((x) => x.id === p.id ? { ...x, stopLoss: newStop } : x),
    orders: [...state.orders.map((o) => o.id === current.id ? { ...o, state: 'cancelled' as const, updatedAt: at, note: `Replaced by ${replacement.id} after confirmation` } : o), replacement],
    activity: [activity(p, at, 'protection', 'Stop tightened manually', `${fmt(current.price)} → ${fmt(newStop)} · replacement confirmed · initial stop and R unchanged`), ...state.activity],
    auditLog: appendAudit(state, at, 'execution', p.accountId, 'Manual stop tightened', `${p.pair} ${dirLabel(p)} · ${fmt(current.price)} → ${fmt(newStop)} · original initial stop retained for reporting`, 'success')
  };
}

export function replaceAccountData(state: DemoState, accountId: string, at: number, data: {openingEquity: number;positions: Position[];orders: OrderRecord[];ledger: DemoState['closedTrades'];activity: ActivityEvent[];signals: DemoState['signals'];sim: AccountSim;}, label: string): DemoState {
  const other = <T extends {accountId: string;},>(list: T[]) => list.filter((x) => x.accountId !== accountId);
  return {
    ...state,
    selectedPositionId: null,
    accounts: state.accounts.map((a) =>
    a.id === accountId ? { ...a, openingEquity: data.openingEquity, scenario: 'healthy', disconnected: false, needsRevalidation: false, lastSyncAt: at, lastSyncAttempt: { at, ok: true } } : a
    ),
    positions: [...other(state.positions), ...data.positions],
    orders: [...other(state.orders), ...data.orders],
    closedTrades: [...other(state.closedTrades), ...data.ledger],
    transfers: other(state.transfers),
    tradeRecords: other(state.tradeRecords),
    closeRequests: other(state.closeRequests),
    pendingEntries: other(state.pendingEntries),
    activity: [...data.activity, ...other(state.activity)],
    signals: [...other(state.signals), ...data.signals],
    accountSim: { ...state.accountSim, [accountId]: data.sim },
    connectionEvents: [{ id: nextId('evt', at), accountId, at, action: 'Demo scenario loaded', outcome: 'info', detail: `${label} · shared account data reset · other accounts unchanged` }, ...state.connectionEvents],
    auditLog: appendAudit(state, at, 'execution', accountId, 'Demo scenario reset', label, 'info')
  };
}

export function executionReducer(state: DemoState, action: ExecutionAction): DemoState {
  switch (action.type) {
    case 'submitClose':
      return submitClose(state, action);
    case 'reconcileOrder':
      return reconcile(state, action.orderId, action.at);
    case 'cancelEntryOrder':
      return cancelEntry(state, action.orderId, action.at);
    case 'tightenStop':
      return tighten(state, action.positionId, action.newStop, action.at);
    case 'loadFixture':{
        const fx = buildFixture(action.accountId, action.fixture);
        const meta = FIXTURES.find((f) => f.id === action.fixture);
        return replaceAccountData(state, action.accountId, action.at, { ...fx, signals: [] }, `${meta?.fixtureName} — ${meta?.label}`);
      }
    case 'restoreAccount':{
        const seed = [...seedAccounts, ...secondUserAccounts].find((a) => a.id === action.accountId);
        const mine = <T extends {accountId: string;},>(list: T[]) => list.filter((x) => x.accountId === action.accountId).map((x) => ({ ...x }));
        return replaceAccountData(
          state,
          action.accountId,
          action.at,
          { openingEquity: seed?.openingEquity ?? 0, positions: mine(seedPositions), orders: mine(seedOrders), ledger: mine(seedLedger), activity: mine(seedActivity), signals: mine(seedSignals), sim: DEFAULT_ACCOUNT_SIM },
          'Original demo data restored'
        );
      }
    default:
      return state;
  }
}