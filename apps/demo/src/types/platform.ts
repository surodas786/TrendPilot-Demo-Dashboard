import type { TokenBlock } from './tradeSettings';
import type { HoldingPosition, PricePoint, SignalProcessing } from './holdings';

export type SignalSide = 'LONG' | 'SHORT';

/** Administrator-configured trading pair with suggested exit defaults (illustrative values). */
export interface TradingPair {
  /** Canonical symbol, e.g. BTCUSDT. */
  symbol: string;
  base: string;
  quote: string;
  enabled: boolean;
  stopLossPct: number;
  takeProfitPct: number;
  trailingEnabled: boolean;
  trailingPct: number;
  updatedAt: number;
}

export interface PriceTick {
  price: number;
  updatedAt: number;
}

export type EntryDirection = 'long' | 'short' | 'both';
export type SignalTimeframe = '5m' | '15m';
export type OppositeBehavior = 'ignore' | 'close' | 'reverse';
export type TrendFilter = 'off' | 'ema200';

export interface StrategyPackage {
  id: string;
  name: string;
  direction: EntryDirection;
  opposite: OppositeBehavior;
  /** Signal timeframe this package follows. Undefined on older packages = "Timeframe not set" (no timeframe filter applied). */
  timeframe?: SignalTimeframe;
  /** Optional entry trend filter. Undefined = Off. Never blocks exits. */
  trendFilter?: TrendFilter;
  status: 'active' | 'inactive';
  /** Seeded demo example — not a recommended strategy. */
  example: boolean;
  createdAt: number;
  updatedAt: number;
}

/** TrendPilot's proposed demo alert format (not an exchange API format). */
export interface AlertMessage {
  signal_id: string;
  symbol: string;
  action: SignalSide;
  timestamp: string;
  /** TradingView {{interval}} value, e.g. "5", "5m", "15" or "15m". Optional in older messages. */
  interval?: string;
  /** Saved route this alert belongs to. Optional: resolved from the mapping when unambiguous. */
  route_id?: string;
  /** TradingView {{exchange}}, e.g. "MEXC". */
  exchange?: string;
  /** TradingView {{time}} — the candle's opening time. */
  bar_time?: string;
  /** Demo-only simulated confirmed close and EMA 200 for the signal candle (production: MEXC candle history). */
  candle_close?: number;
  ema200?: number;
}

export interface CommonSignal {
  id: string;
  receivedAt: number;
  message: AlertMessage;
  outcome: 'accepted' | 'duplicate' | 'rejected';
  reason: string;
  duplicateOf?: string;
}

export type ConnectionTestOutcome = 'success' | 'invalid' | 'no-futures';

/**
 * Simulated live-exchange connection metadata. Never contains an API secret or full key.
 * Stored against the subscriber's unique ID.
 */
export interface ExchangeConnectionMeta {
  id: string;
  subscriberId: string;
  name: string;
  exchange: 'mexc-futures';
  maskedKey: string;
  status: 'connected' | 'disconnected';
  lastTestAt: number;
  createdAt: number;
}

export interface PlatformState {
  /** One simulated MEXC Futures connection per subscriber (metadata only). */
  connections: ExchangeConnectionMeta[];
  /** Subscriber token order blocks, stored against each subscriber's ID. */
  tokenBlocks: TokenBlock[];
  /** Simulated holdings (open and closed), isolated by subscriber ID and mode. */
  positions: HoldingPosition[];
  /** One processing record per accepted signal receipt. */
  processing: SignalProcessing[];
  /** Recorded simulated price points per pair (capped). */
  priceHistory: Record<string, PricePoint[]>;
  pairs: TradingPair[];
  packages: StrategyPackage[];
  signals: CommonSignal[];
  /** Shared simulated price-feed subscription list (one per pair, not per subscriber). */
  feed: string[];
  prices: Record<string, PriceTick>;
}