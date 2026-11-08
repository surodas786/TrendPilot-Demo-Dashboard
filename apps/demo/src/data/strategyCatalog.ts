import { DEMO_START_MS } from './mockData';
import type { InstrumentSpec, PendingEntry, PlatformLimits, ReadinessDemoInputs, RiskSettings } from '../types/risk';
import type { StrategyTemplate, Subscription } from '../types/strategy';

/** Centrally approved strategy catalog (demo). No backtest or performance data is shown or implied. */
export const strategyTemplates: StrategyTemplate[] = [
{
  id: 'supertrend-15m',
  name: 'Supertrend 15m',
  version: '1.0',
  market: 'USDT perpetual futures',
  exchangeId: 'mexc',
  timeframe: '15m',
  timeframeLabel: '15 minutes',
  atrLength: 10,
  supertrendFactor: 3,
  emaLength: 200,
  emaFilterAllowed: true,
  confirmation: 'Completed candle',
  directions: ['long', 'short'],
  maxSignalAgeSec: 30,
  approval: 'approved',
  label: 'Demo strategy — performance not evaluated'
}];


export const strategyRules: {title: string;body: string;}[] = [
{ title: 'Long entry', body: 'A fresh confirmed bullish Supertrend flip, with the candle closing above EMA 200 when the filter is enabled.' },
{ title: 'Short entry', body: 'A fresh confirmed bearish Supertrend flip, with the candle closing below EMA 200 when the filter is enabled.' },
{ title: 'Re-entry', body: 'After an exit, wait for a fresh qualifying flip.' },
{ title: 'One per pair', body: 'Only one position or pending entry per account and pair.' },
{ title: 'No hedging', body: 'Opposite exposure is disabled.' }];


/** Fictional platform caps for this demo. */
export const PLATFORM_LIMITS: PlatformLimits = {
  maxLeverage: 10,
  maxOrderCost: 500,
  maxOpenPositions: 10,
  maxAggregateNotional: 10000,
  maxAggregateStopRisk: 250
};

/** Editable demo defaults — sample configuration values, not trading recommendations. */
export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  defaultOrderCost: 100,
  defaultLeverage: 5,
  maxOpenPositions: 5,
  maxAggregateNotional: 5000,
  maxAggregateStopRisk: 100,
  maxOrderCost: 250,
  dailyLossLimit: 150,
  dailyLossBasis: 'net-plus-unrealized',
  freeMarginReserve: 100,
  cooldownMinutes: 0,
  maxSpreadPct: 0.1,
  maxDeviationPct: 0.3,
  maxSignalAgeSec: 60
};

/** Simulation assumption for the estimated entry fee — not an actual exchange fee. */
export const DEFAULT_SIM_FEE_RATE_PCT = 0.05;

/** Fictional instrument specifications used for rounding. Not actual MEXC specifications. */
export const instrumentSpecs: Record<string, InstrumentSpec> = {
  BTCUSDT: { pair: 'BTCUSDT', baseAsset: 'BTC', contractSize: 0.0001, quantityStep: 0.0001, minQuantity: 0.001, priceDecimals: 1, quantityDecimals: 4 },
  ETHUSDT: { pair: 'ETHUSDT', baseAsset: 'ETH', contractSize: 0.01, quantityStep: 0.01, minQuantity: 0.01, priceDecimals: 2, quantityDecimals: 2 },
  SOLUSDT: { pair: 'SOLUSDT', baseAsset: 'SOL', contractSize: 0.1, quantityStep: 0.1, minQuantity: 0.1, priceDecimals: 2, quantityDecimals: 1 }
};

/**
 * Simulated reference prices for order previews only. Isolated from the
 * historical entry and mark prices of existing demo positions.
 */
export const previewMarket: Record<string, number> = {
  BTCUSDT: 50000,
  ETHUSDT: 2500,
  SOLUSDT: 125
};

export const DEFAULT_READINESS_INPUTS: ReadinessDemoInputs = {
  signalAgeSec: 4,
  spreadPct: 0.04,
  deviationPct: 0.12
};

export const seedPendingEntries: PendingEntry[] = [];

export const seedSubscriptions: Subscription[] = [
{
  id: 'sub-a-trend',
  label: 'Supertrend · BTC & ETH',
  strategyId: 'supertrend-15m',
  version: '1.0',
  accountId: 'acct-a',
  exchangeId: 'mexc',
  pairs: ['BTCUSDT', 'ETHUSDT'],
  directions: 'both',
  emaFilter: true,
  orderCost: 100,
  leverage: 5,
  riskPolicyId: 'acct-a',
  exitPlanId: null,
  lifecycle: 'saved',
  paused: false,
  activated: false,
  createdAt: DEMO_START_MS - 2 * 3600000,
  updatedAt: DEMO_START_MS - 2 * 3600000
}];