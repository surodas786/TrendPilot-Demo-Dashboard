import { createPlatformSeed, refPriceOf } from '../data/platformSeed';
import type { AlertMessage, ExchangeConnectionMeta, PlatformState, StrategyPackage, TradingPair } from '../types/platform';
import type { TokenBlock } from '../types/tradeSettings';
import type { CommonSignal } from '../types/platform';
import { applyPrice, closeRemaining } from '../utils/holdingsMath';

export type PlatformAction =
{type: 'receiveSignal';message: AlertMessage;id: string;at: number;} |
{type: 'setAbsolutePrices';prices: Record<string, number>;at: number;} |
{type: 'applyDemoPrice';symbol: string;price: number;at: number;} |
{type: 'closeHolding';subscriberId: string;positionId: string;at: number;} |
{type: 'savePackage';pkg: StrategyPackage;} |
{type: 'addPair';pair: TradingPair;at: number;} |
{type: 'updatePairDefaults';symbol: string;patch: Pick<TradingPair, 'stopLossPct' | 'takeProfitPct' | 'trailingEnabled' | 'trailingPct'>;at: number;} |
{type: 'setPairEnabled';symbol: string;enabled: boolean;at: number;} |
{type: 'tickPrices';at: number;moves: Record<string, number>;} |
{type: 'resetPlatform';at: number;} |
{type: 'saveConnection';meta: ExchangeConnectionMeta;} |
{type: 'renameConnection';subscriberId: string;name: string;} |
{type: 'disconnectConnection';subscriberId: string;} |
{type: 'recordConnectionTest';subscriberId: string;at: number;} |
{type: 'saveTokenBlock';block: TokenBlock;} |
{type: 'setTokenBlockActive';subscriberId: string;blockId: string;active: boolean;at: number;};

const MAX_SIGNALS = 50;
const MAX_HISTORY = 240;
let seq = 0;

/**
 * Keeps derived fields consistent: the shared feed covers enabled pairs PLUS any pair
 * with open positions (monitoring), and each block's open-position count.
 */
function finalize(state: PlatformState): PlatformState {
  const openSymbols = new Set(state.positions.filter((p) => p.status === 'open').map((p) => p.symbol));
  const wanted = state.pairs.filter((p) => p.enabled || openSymbols.has(p.symbol)).map((p) => p.symbol);
  const feed = [...state.feed.filter((s) => wanted.includes(s)), ...wanted.filter((s) => !state.feed.includes(s))];
  const counts = new Map<string, number>();
  state.positions.forEach((p) => p.status === 'open' && counts.set(p.blockId, (counts.get(p.blockId) ?? 0) + 1));
  const tokenBlocks = state.tokenBlocks.map((b) => (counts.get(b.id) ?? 0) === b.openPositions ? b : { ...b, openPositions: counts.get(b.id) ?? 0 });
  const prices = { ...state.prices };
  feed.forEach((s) => {
    if (!prices[s]) prices[s] = { price: refPriceOf(s), updatedAt: Date.now() };
  });
  return { ...state, feed, tokenBlocks, prices };
}

/** Record one price update for a pair and run it once through every open position's exits. */
function updatePrice(state: PlatformState, symbol: string, price: number, at: number): PlatformState {
  const history = [...(state.priceHistory[symbol] ?? []), { t: at, price }].slice(-MAX_HISTORY);
  return {
    ...state,
    prices: { ...state.prices, [symbol]: { price, updatedAt: at } },
    priceHistory: { ...state.priceHistory, [symbol]: history },
    positions: state.positions.map((p) => p.symbol === symbol && p.status === 'open' ? applyPrice(p, price, at) : p)
  };
}

/** Validation outcome for one receipt. Pure, so the provider can decide on execution with the same rules. */
export function validateAlert(state: PlatformState, message: AlertMessage): Pick<CommonSignal, 'outcome' | 'reason' | 'duplicateOf'> {
  const original = state.signals.find((s) => s.message.signal_id === message.signal_id && s.outcome !== 'duplicate');
  const pair = state.pairs.find((p) => p.symbol === message.symbol);
  let outcome: 'accepted' | 'duplicate' | 'rejected' = 'accepted';
  let reason = 'Passed validation. No subscriber trade is implied — subscriber settings decide later.';
  if (original) {
    outcome = 'duplicate';
    reason = `Signal ID already received at receipt ${original.id}; not processed again.`;
  } else if (!/^[A-Za-z0-9._:-]{4,80}$/.test(message.signal_id)) {
    outcome = 'rejected';
    reason = 'Missing or malformed signal_id.';
  } else if (message.action !== 'LONG' && message.action !== 'SHORT') {
    outcome = 'rejected';
    reason = 'Action must be LONG or SHORT.';
  } else if (!pair) {
    outcome = 'rejected';
    reason = `${message.symbol} is not a configured trading pair.`;
  } else if (!pair.enabled) {
    outcome = 'rejected';
    reason = `${message.symbol} is disabled.`;
  }
  return { outcome, reason, duplicateOf: original?.id };
}

export function nextReceiptId(at: number): string {
  seq += 1;
  return `rcv-${at.toString(36)}-${seq}`;
}

/** Stores one receipt. Execution happens once in the shared store, keyed by signal ID. */
function receive(state: PlatformState, message: AlertMessage, id: string, at: number): PlatformState {
  if (state.signals.some((s) => s.id === id)) return state;
  const receipt: CommonSignal = { id, receivedAt: at, message, ...validateAlert(state, message) };
  return { ...state, signals: [receipt, ...state.signals].slice(0, MAX_SIGNALS) };
}

export function platformReducer(state: PlatformState, action: PlatformAction): PlatformState {
  switch (action.type) {
    case 'receiveSignal':
      return receive(state, action.message, action.id, action.at);
    case 'setAbsolutePrices':{
        let next = state;
        Object.entries(action.prices).forEach(([s, price]) => {
          if (Number.isFinite(price) && price > 0) next = updatePrice(next, s, price, action.at);
        });
        return finalize(next);
      }
    case 'applyDemoPrice':{
        if (!Number.isFinite(action.price) || action.price <= 0 || !state.pairs.some((p) => p.symbol === action.symbol)) return state;
        return finalize(updatePrice(state, action.symbol, action.price, action.at));
      }
    case 'closeHolding':{
        const pos = state.positions.find((p) => p.id === action.positionId && p.subscriberId === action.subscriberId);
        const price = pos && state.prices[pos.symbol]?.price;
        if (!pos || pos.status !== 'open' || !price) return state;
        return finalize({ ...state, positions: state.positions.map((p) => p.id === pos.id ? closeRemaining(p, price, 'Manual close', action.at) : p) });
      }
    case 'savePackage':{
        const clash = state.packages.some((p) => p.id !== action.pkg.id && p.name.trim().toLowerCase() === action.pkg.name.trim().toLowerCase());
        if (clash) return state;
        const exists = state.packages.some((p) => p.id === action.pkg.id);
        return { ...state, packages: exists ? state.packages.map((p) => p.id === action.pkg.id ? action.pkg : p) : [...state.packages, action.pkg] };
      }
    case 'addPair':
      if (state.pairs.some((p) => p.symbol === action.pair.symbol)) return state;
      return finalize({
        ...state,
        pairs: [...state.pairs, action.pair],
        prices: action.pair.enabled ? { ...state.prices, [action.pair.symbol]: state.prices[action.pair.symbol] ?? { price: refPriceOf(action.pair.symbol), updatedAt: action.at } } : state.prices
      });
    case 'updatePairDefaults':
      // Defaults only — subscriber settings and open positions are separate records and are untouched.
      return { ...state, pairs: state.pairs.map((p) => p.symbol === action.symbol ? { ...p, ...action.patch, updatedAt: action.at } : p) };
    case 'setPairEnabled':{
        const pair = state.pairs.find((p) => p.symbol === action.symbol);
        if (!pair || pair.enabled === action.enabled) return state;
        // Disabling stops new entries; pairs with open positions stay monitored via finalize().
        return finalize({
          ...state,
          pairs: state.pairs.map((p) => p.symbol === action.symbol ? { ...p, enabled: action.enabled, updatedAt: action.at } : p),
          prices: action.enabled ? { ...state.prices, [action.symbol]: { price: state.prices[action.symbol]?.price ?? refPriceOf(action.symbol), updatedAt: action.at } } : state.prices
        });
      }
    case 'tickPrices':{
        if (state.feed.length === 0) return state;
        let next = state;
        state.feed.forEach((s) => {
          const prev = next.prices[s]?.price ?? refPriceOf(s);
          next = updatePrice(next, s, prev * (1 + (action.moves[s] ?? 0)), action.at);
        });
        return finalize(next);
      }
    case 'resetPlatform':
      return createPlatformSeed(action.at);
    case 'saveTokenBlock':{
        const b = action.block;
        const prev = state.tokenBlocks.find((x) => x.id === b.id);
        // One block per subscriber + pair + mode.
        const clash = state.tokenBlocks.some((x) => x.id !== b.id && x.subscriberId === b.subscriberId && x.symbol === b.symbol && x.mode === b.mode);
        if (clash) return state;
        // Pair and mode are locked while the block has open positions.
        if (prev && prev.openPositions > 0 && (prev.symbol !== b.symbol || prev.mode !== b.mode)) return state;
        if (prev && prev.subscriberId !== b.subscriberId) return state;
        const next = prev ? { ...b, openPositions: prev.openPositions, version: prev.version + 1 } : b;
        return { ...state, tokenBlocks: prev ? state.tokenBlocks.map((x) => x.id === b.id ? next : x) : [...state.tokenBlocks, next] };
      }
    case 'setTokenBlockActive':
      return {
        ...state,
        tokenBlocks: state.tokenBlocks.map((x) => x.id === action.blockId && x.subscriberId === action.subscriberId ? { ...x, active: action.active, updatedAt: action.at } : x)
      };
    case 'saveConnection':{
        // One connection per subscriber; metadata only (no secret, no full key).
        const m = action.meta;
        const clean: ExchangeConnectionMeta = { id: m.id, subscriberId: m.subscriberId, name: m.name, exchange: 'mexc-futures', maskedKey: m.maskedKey, status: m.status, lastTestAt: m.lastTestAt, createdAt: m.createdAt };
        return { ...state, connections: [...state.connections.filter((c) => c.subscriberId !== m.subscriberId), clean] };
      }
    case 'renameConnection':
      return { ...state, connections: state.connections.map((c) => c.subscriberId === action.subscriberId ? { ...c, name: action.name } : c) };
    case 'disconnectConnection':
      return { ...state, connections: state.connections.map((c) => c.subscriberId === action.subscriberId ? { ...c, status: 'disconnected' } : c) };
    case 'recordConnectionTest':
      return { ...state, connections: state.connections.map((c) => c.subscriberId === action.subscriberId && c.status === 'connected' ? { ...c, lastTestAt: action.at } : c) };
    default:
      return state;
  }
}