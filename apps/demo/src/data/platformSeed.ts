import { DEMO_START_MS } from './mockData';
import type { PlatformState, StrategyPackage, TradingPair } from '../types/platform';

/** Simulated MEXC futures-pair catalogue. Demo data — not a verified live exchange listing. */
export const PAIR_CATALOGUE: {symbol: string;base: string;quote: string;refPrice: number;}[] = [
{ symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', refPrice: 50000 },
{ symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT', refPrice: 2600 },
{ symbol: 'SOLUSDT', base: 'SOL', quote: 'USDT', refPrice: 145 },
{ symbol: 'XRPUSDT', base: 'XRP', quote: 'USDT', refPrice: 0.62 },
{ symbol: 'BNBUSDT', base: 'BNB', quote: 'USDT', refPrice: 590 },
{ symbol: 'DOGEUSDT', base: 'DOGE', quote: 'USDT', refPrice: 0.15 },
{ symbol: 'ADAUSDT', base: 'ADA', quote: 'USDT', refPrice: 0.45 },
{ symbol: 'AVAXUSDT', base: 'AVAX', quote: 'USDT', refPrice: 28 },
{ symbol: 'LINKUSDT', base: 'LINK', quote: 'USDT', refPrice: 14 },
{ symbol: 'DOTUSDT', base: 'DOT', quote: 'USDT', refPrice: 6.2 },
{ symbol: 'LTCUSDT', base: 'LTC', quote: 'USDT', refPrice: 82 },
{ symbol: 'TONUSDT', base: 'TON', quote: 'USDT', refPrice: 5.4 },
{ symbol: 'ARBUSDT', base: 'ARB', quote: 'USDT', refPrice: 0.8 },
{ symbol: 'OPUSDT', base: 'OP', quote: 'USDT', refPrice: 1.7 },
{ symbol: 'NEARUSDT', base: 'NEAR', quote: 'USDT', refPrice: 4.9 }];


export const pairLabel = (p: {base: string;quote: string;}) => `${p.base}/${p.quote}`;
export const refPriceOf = (symbol: string) => PAIR_CATALOGUE.find((c) => c.symbol === symbol)?.refPrice ?? 1;

const t = DEMO_START_MS - 3 * 86400000;

/** Illustrative default values only — not suitability guidance. */
const seedPairs: TradingPair[] = [
{ symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', enabled: true, stopLossPct: 1.5, takeProfitPct: 3, trailingEnabled: true, trailingPct: 1, updatedAt: t },
{ symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT', enabled: true, stopLossPct: 2, takeProfitPct: 4, trailingEnabled: true, trailingPct: 1.5, updatedAt: t },
{ symbol: 'SOLUSDT', base: 'SOL', quote: 'USDT', enabled: true, stopLossPct: 2.5, takeProfitPct: 5, trailingEnabled: false, trailingPct: 2, updatedAt: t },
{ symbol: 'XRPUSDT', base: 'XRP', quote: 'USDT', enabled: false, stopLossPct: 3, takeProfitPct: 6, trailingEnabled: false, trailingPct: 2, updatedAt: t }];


const seedPackages: StrategyPackage[] = [
{ id: 'pkg-ex-ignore', name: 'Example — Trend follow, ignore opposite', direction: 'both', opposite: 'ignore', status: 'active', example: true, createdAt: t, updatedAt: t },
{ id: 'pkg-ex-close', name: 'Example — Long only, close on opposite', direction: 'long', opposite: 'close', status: 'active', example: true, createdAt: t, updatedAt: t },
{ id: 'pkg-ex-reverse', name: 'Example — Long and short reversal', direction: 'both', opposite: 'reverse', status: 'active', example: true, createdAt: t, updatedAt: t },
{ id: 'pkg-ex-short', name: 'Example — Short only, close on opposite', direction: 'short', opposite: 'close', status: 'inactive', example: true, createdAt: t, updatedAt: t }];


export function createPlatformSeed(now: number): PlatformState {
  const feed = seedPairs.filter((p) => p.enabled).map((p) => p.symbol);
  return {
    connections: [],
    tokenBlocks: [],
    positions: [],
    processing: [],
    priceHistory: Object.fromEntries(feed.map((s) => [s, [{ t: now, price: refPriceOf(s) }]])),
    pairs: seedPairs.map((p) => ({ ...p })),
    packages: seedPackages.map((p) => ({ ...p })),
    signals: [],
    feed,
    prices: Object.fromEntries(feed.map((s) => [s, { price: refPriceOf(s), updatedAt: now }]))
  };
}