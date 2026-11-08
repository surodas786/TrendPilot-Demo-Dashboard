import { CLOSE_SLIPPAGE_PCT } from '../../data/mockData';
import { instrumentSpecs } from '../../data/strategyCatalog';
import { ownerOf } from '../../data/demoUsers';
import { round2, summarizeAccount } from '../../utils/accountMath';
import { formatClock } from '../../utils/clock';
import { formatNumber } from '../../utils/format';
import { emaBlocker } from '../../utils/platformText';
import { DAY_LABELS, effectiveDays, localDay, userTimezone } from '../../utils/tradingDays';
import { makeOrder, reservedMarginFor, roundQty, workingStop } from '../../utils/orders';
import { applyCloseFill } from '../executionReducer';
import { applyPaperPrice } from './exitEngine';
import { makeActivity, makeNotification, nextSignalId } from './signalHelpers';
import type { DemoState } from '../demoReducer';
import type { ExchangeConnectionMeta, SignalTimeframe, StrategyPackage, TradingPair } from '../../types/platform';
import type { TokenBlock } from '../../types/tradeSettings';
import type { PositionTarget, SignalProcessing, SkippedBlock, TokenRuntime } from '../../types/holdings';
import type { DemoAccount, Direction, Position } from '../../types/trading';

/** Token-block quantities keep near-full precision; rounding happens only for display. */
export const TOKEN_QTY_DECIMALS = 8;
const MAX_HISTORY = 240;
const EPS = 1e-9;

export function fillModelNote(feePct: number): string {
  return `Simulated fills: ${feePct}% commission per fill and ${CLOSE_SLIPPAGE_PCT}% slippage against the trader, at the shared simulated price (mark = last in this demo). Gross P&L, fees, funding and net are shown separately.`;
}

export interface TokenSignalInput {
  receiptId: string;
  signalId: string;
  symbol: string;
  side: Direction;
  /** Normalized signal timeframe (from the TradingView interval); null when missing or unsupported. */
  timeframe: SignalTimeframe | null;
  /** Raw interval as received, for skip reasons. */
  rawInterval: string | null;
  blocks: TokenBlock[];
  packages: StrategyPackage[];
  pairs: TradingPair[];
  connections: ExchangeConnectionMeta[];
  /** Simulated confirmed close and EMA 200 of the signal candle (same symbol, timeframe, candle). Optional. */
  candleClose?: number | null;
  ema200?: number | null;
}

/** The investor's My Account for the block's mode. Never another investor's account. */
function resolveAccount(s: DemoState, b: TokenBlock): DemoAccount | undefined {
  const own = s.accounts.filter((a) => ownerOf(a) === b.subscriberId && a.environment === b.mode);
  return own.find((a) => a.id === b.accountId) ?? own[0];
}

/** Resizes the working protective stop to the quantity that remains after a partial exit. */
function resizeStop(state: DemoState, positionId: string, at: number): DemoState {
  const p = state.positions.find((x) => x.id === positionId);
  const stop = workingStop(state.orders, positionId);
  if (!p || !stop) return state;
  return {
    ...state,
    orders: state.orders.map((o) => o.id === stop.id ? { ...o, requestedQty: p.quantity, updatedAt: at, note: `Protective stop resized to remaining ${formatNumber(p.quantity, 6)} ${p.baseAsset} · confirmed (simulated)` } : o),
    activity: [makeActivity({ ...p, positionId: p.id }, at, 'protection', 'Stop resized after take profit', `Covers remaining ${formatNumber(p.quantity, 6)} ${p.baseAsset} · confirmed`), ...state.activity]
  };
}

/** Records the simulated market order used to close on a signal. */
function recordMarketClose(state: DemoState, p: Position, ref: number, at: number, note: string): DemoState {
  const price = exitFill(p.direction, ref);
  const order = makeOrder({
    id: nextSignalId('ORD-MC', at),
    accountId: p.accountId,
    positionId: p.id,
    pair: p.pair,
    baseAsset: p.baseAsset,
    purpose: 'manual-close',
    side: p.direction === 'long' ? 'Sell' : 'Buy',
    type: 'Market · reduce-only',
    requestedQty: p.quantity,
    price: ref,
    state: 'filled',
    createdAt: at,
    priceDecimals: p.priceDecimals,
    quantityDecimals: p.quantityDecimals,
    filledQty: p.quantity,
    fills: [{ id: nextSignalId('FIL', at), at, price, quantity: p.quantity, fee: round2(price * p.quantity * (state.simFeeRatePct / 100)) }],
    note
  });
  return { ...state, orders: [...state.orders, order] };
}

export type TokenAction =
{type: 'executeTokenSignal';input: TokenSignalInput;at: number;} |
{type: 'applySharedPrice';pair: string;price: number;at: number;} |
{type: 'setSharedPrices';prices: Record<string, number>;at: number;} |
{type: 'closeTokenPosition';positionId: string;at: number;};

const TOKEN_ACTIONS = new Set(['executeTokenSignal', 'applySharedPrice', 'setSharedPrices', 'closeTokenPosition']);
export function isTokenAction(action: {type: string;}): action is TokenAction {
  return TOKEN_ACTIONS.has(action.type);
}

const slipRate = () => CLOSE_SLIPPAGE_PCT / 100;
/** Entries buy higher / sell lower; exits sell lower / buy higher. */
const entryFill = (side: Direction, ref: number) => side === 'long' ? ref * (1 + slipRate()) : ref * (1 - slipRate());
const exitFill = (side: Direction, ref: number) => side === 'long' ? ref * (1 - slipRate()) : ref * (1 + slipRate());
const fav = (side: Direction, entry: number, pct: number) => side === 'long' ? entry * (1 + pct / 100) : entry * (1 - pct / 100);
const adv = (side: Direction, entry: number, pct: number) => side === 'long' ? entry * (1 - pct / 100) : entry * (1 + pct / 100);
const decimalsFor = (price: number) => price >= 1000 ? 1 : price >= 10 ? 2 : price >= 1 ? 3 : 5;
const dirWord = (d: Direction) => d === 'long' ? 'Long' : 'Short';

function recordPrice(state: DemoState, pair: string, price: number, at: number): DemoState {
  const history = [...(state.priceHistory[pair] ?? []), { t: at, price }].slice(-MAX_HISTORY);
  return {
    ...state,
    paperPrices: { ...state.paperPrices, [pair]: price },
    priceTimes: { ...state.priceTimes, [pair]: at },
    priceHistory: { ...state.priceHistory, [pair]: history }
  };
}

function patchPosition(state: DemoState, id: string, patch: (p: Position) => Position): DemoState {
  return { ...state, positions: state.positions.map((p) => p.id === id ? patch(p) : p) };
}

function accountSummary(state: DemoState, accountId: string) {
  const account = state.accounts.find((a) => a.id === accountId)!;
  return summarizeAccount(
    account,
    state.positions.filter((p) => p.accountId === accountId),
    state.closedTrades.filter((t) => t.accountId === accountId),
    state.transfers.filter((t) => t.accountId === accountId),
    reservedMarginFor(state.orders, accountId)
  );
}

/**
 * One closing fill for a token position through the shared close logic (ledger, fees,
 * margin release, trade record). The final fill archives the position for Holdings.
 */
function closeTokenFill(state: DemoState, positionId: string, qtyIn: number, ref: number, at: number, reason: string, receiptId?: string): DemoState {
  const p = state.positions.find((x) => x.id === positionId);
  if (!p || !p.tokenRuntime || qtyIn <= 0) return state;
  const qty = Math.min(qtyIn, p.quantity);
  const price = exitFill(p.direction, ref);
  const final = roundQty(p.quantity - qty, p.quantityDecimals) <= 0;
  let s = state;
  if (final) {
    const rt: TokenRuntime = { ...p.tokenRuntime, closedAtMs: at, closeReason: reason, targets: p.tokenRuntime.targets.map((t) => t.state === 'open' ? { ...t, state: 'cancelled' } : t) };
    s = { ...s, tokenArchive: [{ ...p, quantity: 0, closedQuantity: rt.originalQty, markPrice: ref, tokenRuntime: rt }, ...s.tokenArchive] };
  }
  const before = s.closedTrades.length;
  s = applyCloseFill(s, p.id, final ? p.quantity : qty, price, at, reason);
  if (s.closedTrades.length > before) {
    // Tag the exit fill with its reason (and source signal) so every history view shows the same cause.
    s = { ...s, closedTrades: s.closedTrades.map((t, i) => i === s.closedTrades.length - 1 ? { ...t, reason: receiptId ? `${reason} · receipt ${receiptId}` : reason } : t) };
  }
  return s;
}

function fillWorkingStop(state: DemoState, p: Position, ref: number, at: number): DemoState {
  const stop = workingStop(state.orders, p.id);
  if (!stop) return state;
  const price = exitFill(p.direction, ref);
  return {
    ...state,
    orders: state.orders.map((o) =>
    o.id === stop.id ?
    { ...o, state: 'filled', triggerState: 'triggered', filledQty: p.quantity, updatedAt: at, fills: [{ id: nextSignalId('FIL', at), at, price, quantity: p.quantity, fee: round2(price * p.quantity * (state.simFeeRatePct / 100)) }] } :
    o
    )
  };
}

function recordTakeProfitOrder(state: DemoState, p: Position, qty: number, ref: number, at: number): DemoState {
  const price = exitFill(p.direction, ref);
  const order = makeOrder({
    id: nextSignalId('ORD-TP', at),
    accountId: p.accountId,
    positionId: p.id,
    pair: p.pair,
    baseAsset: p.baseAsset,
    purpose: 'take-profit',
    side: p.direction === 'long' ? 'Sell' : 'Buy',
    type: 'Take profit · reduce-only',
    requestedQty: qty,
    price: ref,
    state: 'filled',
    createdAt: at,
    priceDecimals: p.priceDecimals,
    quantityDecimals: p.quantityDecimals,
    filledQty: qty,
    fills: [{ id: nextSignalId('FIL', at), at, price, quantity: qty, fee: round2(price * qty * (state.simFeeRatePct / 100)) }]
  });
  return { ...state, orders: [...state.orders, order] };
}

/** Runs one price update through every token position on the pair, in a fixed order: stops, targets, trailing. */
function applyTokenPrice(state: DemoState, pair: string, price: number, at: number): DemoState {
  let s = state;
  const ids = s.positions.filter((p) => p.pair === pair && p.tokenRuntime).map((p) => p.id);
  for (const id of ids) {
    let p = s.positions.find((x) => x.id === id);
    if (!p || !p.tokenRuntime) continue;
    s = patchPosition(s, id, (x) => ({ ...x, markPrice: price }));
    p = s.positions.find((x) => x.id === id)!;
    const rt = p.tokenRuntime!;
    const long = p.direction === 'long';

    // 1. Stops use the levels from before this update.
    const hitStop = long ? price <= rt.stopPrice : price >= rt.stopPrice;
    const hitTrail = rt.trailingStop !== null && (long ? price <= rt.trailingStop : price >= rt.trailingStop);
    if (hitStop || hitTrail) {
      const trailTighter = hitTrail && (!hitStop || (long ? rt.trailingStop! >= rt.stopPrice : rt.trailingStop! <= rt.stopPrice));
      s = fillWorkingStop(s, p, price, at);
      s = closeTokenFill(s, id, p.quantity, price, at, trailTighter ? 'Trailing stop' : 'Stop loss');
      continue;
    }

    // 2. Crossed take-profit targets, in order, sized from the original quantity and capped at what remains.
    for (let i = 0; i < rt.targets.length; i += 1) {
      const cur = s.positions.find((x) => x.id === id);
      if (!cur || !cur.tokenRuntime) break;
      const t = cur.tokenRuntime.targets[i];
      if (t.state !== 'open' || !(long ? price >= t.price : price <= t.price)) continue;
      const isLast = cur.tokenRuntime.targets.slice(i + 1).every((x) => x.state !== 'open');
      const want = isLast ? cur.quantity : Math.min(cur.quantity, roundQty(cur.tokenRuntime.originalQty * t.closePct / 100, cur.quantityDecimals));
      const targets = cur.tokenRuntime.targets.map((x, j) => j === i ? { ...x, state: 'filled' as const } : x);
      s = patchPosition(s, id, (x) => ({ ...x, tokenRuntime: { ...x.tokenRuntime!, targets }, takeProfit: targets.find((x2) => x2.state === 'open')?.price ?? x.takeProfit }));
      s = recordTakeProfitOrder(s, cur, want, price, at);
      s = closeTokenFill(s, id, want, price, at, `Take profit ${i + 1}`);
      // The protective stop always matches what remains.
      s = resizeStop(s, id, at);
    }

    // 3. Trailing level follows the best price and never moves backward.
    const after = s.positions.find((x) => x.id === id);
    if (after?.tokenRuntime?.trailingEnabled) {
      const r = after.tokenRuntime;
      const best = long ? Math.max(r.bestPrice, price) : Math.min(r.bestPrice, price);
      const level = adv(after.direction, best, r.trailingPct);
      const prev = r.trailingStop ?? level;
      const trail = long ? Math.max(prev, level) : Math.min(prev, level);
      if (trail !== r.trailingStop || best !== r.bestPrice) {
        const effective = long ? Math.max(r.stopPrice, trail) : Math.min(r.stopPrice, trail);
        s = patchPosition(s, id, (x) => ({ ...x, stopLoss: effective, trailingState: `Tracking best ${formatNumber(best, x.priceDecimals)} · level ${formatNumber(trail, x.priceDecimals)}`, tokenRuntime: { ...r, bestPrice: best, trailingStop: trail } }));
        const stop = workingStop(s.orders, id);
        if (stop) s = { ...s, orders: s.orders.map((o) => o.id === stop.id ? { ...o, price: effective, updatedAt: at, note: 'Trailing level (simulated)' } : o) };
      }
    }
  }
  return s;
}

/** First unmet entry requirement for a block, or null. Margin is checked against the shared account summary. */
function entryBlocker(s: DemoState, b: TokenBlock, input: TokenSignalInput, opened: number, at: number): string | null {
  const account = resolveAccount(s, b);
  if (!account) return `My Account has no ${b.mode === 'live' ? 'Live — simulated' : 'Paper'} balance yet.`;
  const user = s.users.find((u) => u.id === b.subscriberId);
  if (!user || user.status !== 'active') return user?.status === 'suspended' ? 'subscriber suspended — new entries blocked.' : 'subscriber account is not active.';
  if (s.globalHalt) return 'global entry halt by an administrator.';
  if (user.entriesPaused) return 'entries paused for this subscriber by an administrator.';
  if (account.disconnected) return 'trading account is disconnected.';
  if (account.entriesPaused) return 'new entries are paused on this trading account.';
  if (!b.active) return 'token block is paused.';
  const pair = input.pairs.find((p) => p.symbol === b.symbol);
  if (!pair || !pair.enabled) return 'pair disabled by the administrator.';
  const pkg = input.packages.find((p) => p.id === b.packageId);
  if (!pkg || pkg.status !== 'active') return 'strategy package is inactive.';
  if (!(pkg.direction === 'both' || pkg.direction === input.side)) return `package allows ${pkg.direction} entries only.`;
  // Optional EMA 200 trend filter: first entries, additional entries and the new entry after a reversal. Never exits.
  if (pkg.trendFilter === 'ema200') {
    const ema = emaBlocker(input.side, input.candleClose, input.ema200);
    if (ema) return ema.charAt(0).toLowerCase() + ema.slice(1);
  }
  if (b.mode === 'live') {
    const conn = input.connections.find((c) => c.subscriberId === b.subscriberId);
    if (!conn || conn.status !== 'connected') return 'Live — simulated needs a connected simulated exchange.';
  }
  const own = s.positions.filter((p) => p.tokenRuntime?.blockId === b.id);
  const max = b.allowAdditionalEntries ? b.maxEntriesPerDirection : 1;
  if (own.filter((p) => p.direction === input.side).length + opened >= max) return b.allowAdditionalEntries ? `entry limit reached (${max} ${input.side} per direction).` : `already holding a ${input.side}; additional entries are off.`;
  if (own.some((p) => p.direction !== input.side) && !b.allowSimultaneousDirections) return 'opposite position still open and simultaneous directions are off.';
  const ref = s.paperPrices[b.symbol];
  if (!ref || !Number.isFinite(ref) || ref <= 0) return 'no valid simulated price for this pair.';
  const fee = b.orderCost * b.leverage * s.simFeeRatePct / 100;
  const available = accountSummary(s, account.id).availableMargin;
  if (available < b.orderCost + fee - EPS) return `insufficient available margin: needs ${formatNumber(b.orderCost + fee)} USDT (order cost + entry fee), has ${formatNumber(available)} USDT.`;
  // Trading-day schedule: checked last, immediately before the entry opens. Never affects exits or closes.
  const tz = userTimezone(user);
  const day = localDay(at, tz);
  if (!effectiveDays(b.tradingDays).includes(day)) return `skipped — trading day disabled (${DAY_LABELS[day]}, ${tz}).`;
  return null;
}

function openEntry(s: DemoState, b: TokenBlock, pkg: StrategyPackage, account: DemoAccount, input: TokenSignalInput, idx: number, at: number): {state: DemoState;id: string;} {
  const side = input.side;
  const ref = s.paperPrices[b.symbol];
  const spec = instrumentSpecs[b.symbol];
  const priceDecimals = spec?.priceDecimals ?? decimalsFor(ref);
  const baseAsset = spec?.baseAsset ?? b.symbol.replace(/USDT$/, '');
  const fill = entryFill(side, ref);
  const qty = roundQty(b.orderCost * b.leverage / fill, TOKEN_QTY_DECIMALS);
  const fee = round2(fill * qty * (s.simFeeRatePct / 100));
  const stopPrice = adv(side, fill, b.stopLossPct);
  const targets: PositionTarget[] = b.takeProfits.map((t) => ({ movePct: t.movePct, closePct: t.closePct, price: fav(side, fill, t.movePct), state: 'open' }));
  const id = `pos-${input.receiptId}-${idx}`;
  const fmt = (v: number) => formatNumber(v, priceDecimals);
  const runtime: TokenRuntime = {
    subscriberId: b.subscriberId,
    blockId: b.id,
    packageId: pkg.id,
    packageName: pkg.name,
    receiptId: input.receiptId,
    signalId: input.signalId,
    orderCost: b.orderCost,
    marginMode: b.marginMode,
    originalQty: qty,
    stopLossPct: b.stopLossPct,
    stopPrice,
    targets,
    trailingEnabled: b.trailingEnabled,
    trailingPct: b.trailingPct,
    bestPrice: fill,
    trailingStop: b.trailingEnabled ? adv(side, fill, b.trailingPct) : null,
    openedAtMs: at
  };
  const position: Position = {
    id,
    accountId: account.id,
    exchangeId: account.exchangeId,
    pair: b.symbol,
    baseAsset,
    direction: side,
    strategyId: pkg.id,
    quantity: qty,
    closedQuantity: 0,
    allocatedCost: round2(fill * qty / b.leverage),
    leverage: b.leverage,
    entryPrice: fill,
    markPrice: ref,
    stopLoss: runtime.trailingStop !== null ? side === 'long' ? Math.max(stopPrice, runtime.trailingStop) : Math.min(stopPrice, runtime.trailingStop) : stopPrice,
    takeProfit: targets[0]?.price ?? Number.NaN,
    initialStop: stopPrice,
    trailingState: b.trailingEnabled ? `Tracking best ${fmt(fill)} · ${b.trailingPct}% distance` : 'Off for this block',
    protection: 'protected',
    marginMode: b.marginMode === 'cross' ? 'Cross' : 'Isolated',
    triggerBasis: 'Shared simulated price (mark = last)',
    openedAt: formatClock(at),
    priceDecimals,
    quantityDecimals: TOKEN_QTY_DECIMALS,
    managed: true,
    strategyVersion: `block v${b.version}`,
    subscriptionLabel: `${pkg.name} · token block`,
    exitSnapshot: {
      planLabel: `Token block · SL ${b.stopLossPct}% · TP ${b.takeProfits.map((t) => `${t.movePct}%/${t.closePct}%`).join(', ')}`,
      mode: 'Percentage exits',
      partialTarget: targets.length > 1 ? `${fmt(targets[0].price)} (${targets[0].movePct}%)` : null,
      closePct: targets.length > 1 ? targets[0].closePct : null,
      trailing: b.trailingEnabled ? `${b.trailingPct}%` : null,
      bestPrice: null,
      oppositeExit: pkg.opposite !== 'ignore'
    },
    sourceSignalId: input.signalId,
    tokenRuntime: runtime
  };
  const common = { accountId: account.id, positionId: id, pair: b.symbol, baseAsset, priceDecimals, quantityDecimals: TOKEN_QTY_DECIMALS };
  // The reservation is created and converted to used margin in the same simulated step: the entry fills immediately.
  const entryOrder = makeOrder({ ...common, id: nextSignalId('ORD-EN', at), purpose: 'entry', side: side === 'long' ? 'Buy' : 'Sell', type: 'Market', requestedQty: qty, price: ref, state: 'filled', createdAt: at, leverage: b.leverage, filledQty: qty, fills: [{ id: nextSignalId('FIL', at), at, price: fill, quantity: qty, fee }], note: `Token block ${b.id} · signal ${input.signalId}` });
  // The protective stop is submitted with the entry and covers the full filled quantity.
  const stopOrder = makeOrder({ ...common, id: nextSignalId('ORD-SL', at), purpose: 'stop-loss', side: side === 'long' ? 'Sell' : 'Buy', type: 'Stop market · reduce-only', requestedQty: qty, price: position.stopLoss, state: 'submitted', createdAt: at, note: `Protective stop confirmed (simulated) · covers ${formatNumber(qty, 6)} ${baseAsset}` });
  const ledgerFee = { id: nextSignalId('led', at), kind: 'entry-fee' as const, positionId: id, at, closedAt: formatClock(at), accountId: account.id, strategyId: pkg.id, pair: b.symbol, direction: side, grossPnl: 0, commission: fee, fundingPaid: 0, fundingReceived: 0, reason: `Entry commission · signal ${input.signalId}` };
  return {
    id,
    state: {
      ...s,
      positions: [...s.positions, position],
      orders: [...s.orders, entryOrder, stopOrder],
      closedTrades: [...s.closedTrades, ledgerFee],
      activity: [makeActivity({ ...position, positionId: id }, at, 'entry', 'Token-block entry filled', `${dirWord(side)} ${formatNumber(qty, 6)} ${baseAsset} at ${fmt(fill)} · fee ${formatNumber(fee)} · stop ${fmt(position.stopLoss)} confirmed`), ...s.activity],
      notifications: [makeNotification(s, account.id, at, 'Entry filled', `${b.symbol} ${dirWord(side)} · ${account.name} · ${formatNumber(qty, 6)} ${baseAsset} at ${fmt(fill)}`, 'success'), ...s.notifications]
    }
  };
}

/** Evaluates one accepted signal once per matching token block. Recorded so replays and refreshes never repeat it. */
function executeTokenSignal(state: DemoState, input: TokenSignalInput, at: number): DemoState {
  if (state.tokenProcessing.some((r) => r.signalId === input.signalId)) return state;
  let s = state;
  const record: SignalProcessing = { receiptId: input.receiptId, signalId: input.signalId, at, opened: [], closed: [], skipped: [], notes: [] };
  const skip = (b: TokenBlock, reason: string) => record.skipped.push({ subscriberId: b.subscriberId, blockId: b.id, mode: b.mode, reason, accountId: b.accountId } as SkippedBlock);
  const blocks = input.blocks.filter((b) => b.symbol === input.symbol);
  if (blocks.length === 0) record.notes.push('No subscriber token blocks are configured for this pair.');

  blocks.forEach((b, bi) => {
    const pkg = input.packages.find((p) => p.id === b.packageId);
    // Timeframe is checked before any LONG/SHORT rule: no entry, opposite close or reversal from another timeframe.
    // Packages without a saved timeframe keep their earlier behavior (no filter).
    if (pkg?.timeframe) {
      if (!input.rawInterval) return skip(b, 'Skipped: signal timeframe missing.');
      if (input.timeframe !== pkg.timeframe) return skip(b, `Skipped: timeframe mismatch — signal ${input.timeframe ?? input.rawInterval}, package ${pkg.timeframe}.`);
    }
    const opposite = s.positions.filter((p) => p.tokenRuntime?.blockId === b.id && p.direction !== input.side);
    let closedPrefix = '';
    if (opposite.length > 0) {
      const behavior = pkg?.opposite ?? 'ignore';
      if (!(b.allowSimultaneousDirections && behavior === 'ignore')) {
        if (behavior === 'ignore') return skip(b, 'Opposite signal ignored by the package; existing position held.');
        const ref = s.paperPrices[b.symbol];
        if (!ref) return skip(b, 'No valid simulated price; opposite position not closed.');
        // Close on signal: a simulated market order for the remaining quantity, confirmed before any new entry is checked.
        opposite.forEach((op) => {
          const cur = s.positions.find((x) => x.id === op.id);
          if (!cur) return; // already closed — never close the same quantity twice
          s = recordMarketClose(s, cur, ref, at, `Close on opposite signal ${input.signalId}`);
          s = closeTokenFill(s, op.id, cur.quantity, ref, at, 'Opposite signal', input.receiptId);
          record.closed.push(op.id);
        });
        if (behavior === 'close') return skip(b, `Closed ${opposite.length} ${opposite[0].direction} position(s) on opposite signal; package does not reverse.`);
        closedPrefix = `Closed ${opposite.length} ${opposite[0].direction} position(s); `;
      }
    }
    const reason = entryBlocker(s, b, input, 0, at);
    if (reason || !pkg) {
      const text = reason ?? 'strategy package is inactive.';
      const full = closedPrefix ? `${closedPrefix}new entry blocked — ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
      const acct = resolveAccount(s, b);
      if (acct && (reason?.startsWith('insufficient') || reason?.includes('EMA 200') || reason?.includes('trading day disabled'))) {
        const title = reason.includes('trading day') ? 'Skipped — trading day disabled' : reason.includes('EMA') ? 'Entry blocked — EMA 200 filter' : 'Entry rejected — insufficient margin';
        s = { ...s, activity: [makeActivity({ accountId: acct.id, strategyId: b.packageId, pair: b.symbol }, at, 'reject', title, full), ...s.activity] };
      }
      return skip(b, full);
    }
    const account = resolveAccount(s, b)!;
    const res = openEntry(s, b, pkg, account, input, bi, at);
    s = res.state;
    record.opened.push(res.id);
    if (closedPrefix) record.notes.push(`${closedPrefix}opened ${input.side} after the close completed.`);
  });

  return { ...s, tokenProcessing: [record, ...s.tokenProcessing] };
}

export function tokenReducer(state: DemoState, action: TokenAction): DemoState {
  switch (action.type) {
    case 'executeTokenSignal':
      return executeTokenSignal(state, action.input, action.at);
    case 'applySharedPrice':{
        if (!Number.isFinite(action.price) || action.price <= 0) return state;
        let s = recordPrice(state, action.pair, action.price, action.at);
        // Every position on the pair is valued at the one shared price. Exit rules run only for positions that own them.
        s = { ...s, positions: s.positions.map((p) => p.pair === action.pair && !p.tokenRuntime && (!p.exitRuntime || p.managed === false) ? { ...p, markPrice: action.price } : p) };
        s = applyPaperPrice(s, action.pair, action.price, action.at);
        return applyTokenPrice(s, action.pair, action.price, action.at);
      }
    case 'setSharedPrices':{
        // Background drift: only pairs without open positions, so no valuation or exit changes here.
        let s = state;
        Object.entries(action.prices).forEach(([pair, price]) => {
          if (Number.isFinite(price) && price > 0 && !s.positions.some((p) => p.pair === pair)) s = recordPrice(s, pair, price, action.at);
        });
        return s;
      }
    case 'closeTokenPosition':{
        const p = state.positions.find((x) => x.id === action.positionId && x.tokenRuntime);
        if (!p) return state; // already closed — repeated clicks do nothing
        const ref = state.paperPrices[p.pair] ?? p.markPrice;
        return closeTokenFill(state, p.id, p.quantity, ref, action.at, 'Manual close');
      }
    default:
      return state;
  }
}

/** Summed gross, fees and net for a position from the shared ledger. */
export function positionLedger(state: Pick<DemoState, 'closedTrades'>, positionId: string) {
  const rows = state.closedTrades.filter((t) => t.positionId === positionId);
  const exits = rows.filter((t) => t.kind === 'partial' || t.kind === 'final');
  const gross = exits.reduce((a, t) => a + t.grossPnl, 0);
  const fees = rows.reduce((a, t) => a + t.commission, 0);
  const funding = rows.reduce((a, t) => a + t.fundingReceived - t.fundingPaid, 0);
  return { exits, gross, fees, funding, net: gross - fees + funding };
}