import type {
  ActivityEvent,
  ClosedTrade,
  ConnectionEvent,
  DemoAccount,
  EquitySeriesSet,
  Exchange,
  HealthService,
  NotificationItem,
  PaperTransfer,
  Position,
  SignalRecord,
  Strategy } from
'../types/trading';

/**
 * Central mock data model for the TrendPilot demo.
 * All figures are fictional and simulated. Account-level totals are derived
 * from positions, closed trades and paper transfers (see utils/accountMath.ts),
 * so filters, summaries, tables, connection cards and detail panels stay consistent.
 */

export const DEMO_NOW_ISO = '2026-11-04T14:32:10+06:00';
export const DEMO_START_MS = Date.parse(DEMO_NOW_ISO);
export const REPORTING_DATE = '2026-11-04';
export const REPORTING_TIMEZONE = 'Asia/Dhaka';
/** Legacy closing fee constant (closing fills now use the shared simulation fee rate). */
export const CLOSING_FEE_RATE = 0.0005;
/** Slippage assumption for simulated market closes (percent, adverse to the position). */
export const CLOSE_SLIPPAGE_PCT = 0.02;
export const DEFAULT_VIRTUAL_FUNDS = 5000;

/** Demo limits only — not claims about any exchange's current limits. */
export const PAIR_OPTIONS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
export const LEVERAGE_OPTIONS = [1, 2, 3, 5, 10];

const HOUR = 3600000;
const DAY = 24 * HOUR;

/** Exchange registry. Structure is ready for more venues; only enabled ones are shown. */
export const exchangeRegistry: Exchange[] = [{ id: 'mexc', name: 'MEXC Futures', enabled: true }];

/** Exchanges visible in the interface. MEXC Futures is the only supported exchange in this demo. */
export const exchanges: Exchange[] = exchangeRegistry.filter((e) => e.enabled);

export const accounts: DemoAccount[] = [
{
  id: 'acct-a',
  name: 'Demo Account A',
  descriptor: 'Main paper account',
  exchangeId: 'mexc',
  environment: 'paper',
  openingEquity: 5000,
  maxOpenPositions: 3,
  maskedKey: 'DEMO-••••-A7Q2',
  createdAt: DEMO_START_MS - 12 * DAY,
  preferences: { allowedPairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], positionMode: 'One-way', marginMode: 'Isolated', leverage: 10, isDefault: true },
  scenario: 'healthy',
  disconnected: false,
  entriesPaused: false,
  needsRevalidation: false,
  lastSyncAt: DEMO_START_MS - 8000,
  lastSyncAttempt: { at: DEMO_START_MS - 8000, ok: true },
  lastValidation: { at: DEMO_START_MS - 6 * HOUR, ok: true }
},
{
  id: 'acct-b',
  name: 'Demo Account B',
  descriptor: 'Conservative paper account',
  exchangeId: 'mexc',
  environment: 'paper',
  openingEquity: 2500,
  maxOpenPositions: 2,
  maskedKey: 'DEMO-••••-K4M9',
  createdAt: DEMO_START_MS - 5 * DAY,
  preferences: { allowedPairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], positionMode: 'One-way', marginMode: 'Isolated', leverage: 5, isDefault: false },
  scenario: 'healthy',
  disconnected: false,
  entriesPaused: false,
  needsRevalidation: false,
  lastSyncAt: DEMO_START_MS - 11000,
  lastSyncAttempt: { at: DEMO_START_MS - 11000, ok: true },
  lastValidation: { at: DEMO_START_MS - 5 * HOUR, ok: true }
}];


export const strategies: Strategy[] = [
{ id: 'trend-4h', name: 'Trend Breakout 4H', timeframe: '4H' },
{ id: 'meanrev-1h', name: 'Mean Reversion 1H', timeframe: '1H' },
{ id: 'momentum-15m', name: 'Momentum 15m', timeframe: '15m' },
{ id: 'supertrend-15m', name: 'Supertrend 15m', timeframe: '15m' }];


export const positions: Position[] = [
{
  id: 'pos-btc',
  accountId: 'acct-a',
  exchangeId: 'mexc',
  pair: 'BTCUSDT',
  baseAsset: 'BTC',
  direction: 'long',
  strategyId: 'trend-4h',
  quantity: 0.016,
  closedQuantity: 0,
  allocatedCost: 100,
  leverage: 10,
  entryPrice: 62500,
  markPrice: 64125,
  stopLoss: 61200,
  takeProfit: 66000,
  initialStop: 61200,
  trailingState: 'Armed · activates at 64,500.0',
  protection: 'protected',
  marginMode: 'Isolated',
  triggerBasis: 'Mark price (simulated)',
  openedAt: '08:00:05',
  priceDecimals: 1,
  quantityDecimals: 3
},
{
  id: 'pos-eth',
  accountId: 'acct-a',
  exchangeId: 'mexc',
  pair: 'ETHUSDT',
  baseAsset: 'ETH',
  direction: 'short',
  strategyId: 'meanrev-1h',
  quantity: 0.3,
  closedQuantity: 0,
  allocatedCost: 120,
  leverage: 8,
  entryPrice: 3200,
  markPrice: 3140,
  stopLoss: 3260,
  takeProfit: 3050,
  initialStop: 3260,
  trailingState: 'Not configured for this strategy',
  protection: 'protected',
  marginMode: 'Isolated',
  triggerBasis: 'Mark price (simulated)',
  openedAt: '10:00:06',
  priceDecimals: 2,
  quantityDecimals: 2
},
{
  id: 'pos-sol',
  accountId: 'acct-a',
  exchangeId: 'mexc',
  pair: 'SOLUSDT',
  baseAsset: 'SOL',
  direction: 'long',
  strategyId: 'momentum-15m',
  quantity: 2.5,
  closedQuantity: 1.25,
  allocatedCost: 120,
  leverage: 5,
  entryPrice: 160,
  markPrice: 158.4,
  stopLoss: 154,
  takeProfit: 176,
  initialStop: 154,
  trailingState: 'Inactive · starts after TP2',
  protection: 'verifying',
  marginMode: 'Isolated',
  triggerBasis: 'Mark price (simulated)',
  openedAt: '09:15:04',
  priceDecimals: 2,
  quantityDecimals: 2
},
{
  id: 'pos-b-eth',
  accountId: 'acct-b',
  exchangeId: 'mexc',
  pair: 'ETHUSDT',
  baseAsset: 'ETH',
  direction: 'long',
  strategyId: 'trend-4h',
  quantity: 0.16,
  closedQuantity: 0,
  allocatedCost: 50,
  leverage: 10,
  entryPrice: 3125,
  markPrice: 3140,
  stopLoss: 3060,
  takeProfit: 3260,
  initialStop: 3060,
  trailingState: 'Inactive · activates at 3,200.00',
  protection: 'protected',
  marginMode: 'Isolated',
  triggerBasis: 'Mark price (simulated)',
  openedAt: '04:00:04',
  priceDecimals: 2,
  quantityDecimals: 2
},
{
  id: 'pos-b-btc',
  accountId: 'acct-b',
  exchangeId: 'mexc',
  pair: 'BTCUSDT',
  baseAsset: 'BTC',
  direction: 'short',
  strategyId: 'meanrev-1h',
  quantity: 0.0032,
  closedQuantity: 0,
  allocatedCost: 40,
  leverage: 5,
  entryPrice: 62500,
  markPrice: 64125,
  stopLoss: 65000,
  takeProfit: 60800,
  /** Opened before initial-stop snapshots were recorded — risk data incomplete. */
  initialStop: null,
  trailingState: 'Not configured for this strategy',
  protection: 'protected',
  marginMode: 'Isolated',
  triggerBasis: 'Mark price (simulated)',
  openedAt: '09:00:04',
  priceDecimals: 1,
  quantityDecimals: 4
}];


/**
 * Realized ledger for the reporting day. Entries marked 'opening-summary' are reconciled
 * daily totals without itemized trade records — they are never turned into invented trades.
 * trade-a3 is the recorded partial take profit of the open SOLUSDT position.
 */
export const closedTrades: ClosedTrade[] = [
{ id: 'trade-a1', kind: 'opening-summary', accountId: 'acct-a', strategyId: 'meanrev-1h', pair: 'ETHUSDT', direction: 'short', closedAt: '04:00:05', grossPnl: 38, commission: 1.6, fundingPaid: 0.9, fundingReceived: 0 },
{ id: 'trade-a2', kind: 'opening-summary', accountId: 'acct-a', strategyId: 'trend-4h', pair: 'BTCUSDT', direction: 'long', closedAt: '05:20:15', grossPnl: 62, commission: 2.4, fundingPaid: 1.2, fundingReceived: 0 },
{ id: 'trade-a3', kind: 'partial', positionId: 'pos-sol', quantity: 1.25, fillPrice: 168, accountId: 'acct-a', strategyId: 'momentum-15m', pair: 'SOLUSDT', direction: 'long', closedAt: '11:42:18', grossPnl: 10, commission: 1.0, fundingPaid: 0.4, fundingReceived: 0 },
{ id: 'trade-b1', kind: 'opening-summary', accountId: 'acct-b', strategyId: 'meanrev-1h', pair: 'SOLUSDT', direction: 'long', closedAt: '06:40:12', grossPnl: -12, commission: 1.2, fundingPaid: 0.3, fundingReceived: 0.5 }];


export const transfers: PaperTransfer[] = [];

export const activityEvents: ActivityEvent[] = [
{ id: 'act-a01', kind: 'exit', title: 'Paper exit filled', detail: 'Short closed on exit signal · +38.00 USDT gross', accountId: 'acct-a', strategyId: 'meanrev-1h', pair: 'ETHUSDT', time: '04:00:05' },
{ id: 'act-a02', kind: 'take-profit', title: 'Take profit filled', detail: 'Long closed at target · +62.00 USDT gross', accountId: 'acct-a', strategyId: 'trend-4h', pair: 'BTCUSDT', time: '05:20:15' },
{ id: 'act-a03', kind: 'entry', title: 'Paper entry filled', detail: 'Long 0.016 BTC at 62,500.0 · 10×', accountId: 'acct-a', strategyId: 'trend-4h', pair: 'BTCUSDT', time: '08:00:05', positionId: 'pos-btc' },
{ id: 'act-a04', kind: 'protection', title: 'Protective stop confirmed', detail: 'Stop 61,200.0 · Target 66,000.0', accountId: 'acct-a', strategyId: 'trend-4h', pair: 'BTCUSDT', time: '08:00:09', positionId: 'pos-btc' },
{ id: 'act-a05', kind: 'entry', title: 'Paper entry filled', detail: 'Long 3.75 SOL at 160.00 · 5×', accountId: 'acct-a', strategyId: 'momentum-15m', pair: 'SOLUSDT', time: '09:15:04', positionId: 'pos-sol' },
{ id: 'act-a06', kind: 'protection', title: 'Protective stop confirmed', detail: 'Stop 154.00 · TP1 168.00 · TP2 176.00', accountId: 'acct-a', strategyId: 'momentum-15m', pair: 'SOLUSDT', time: '09:15:08', positionId: 'pos-sol' },
{ id: 'act-a07', kind: 'entry', title: 'Paper entry filled', detail: 'Short 0.30 ETH at 3,200.00 · 8×', accountId: 'acct-a', strategyId: 'meanrev-1h', pair: 'ETHUSDT', time: '10:00:06', positionId: 'pos-eth' },
{ id: 'act-a08', kind: 'protection', title: 'Protective stop confirmed', detail: 'Stop 3,260.00 · Target 3,050.00', accountId: 'acct-a', strategyId: 'meanrev-1h', pair: 'ETHUSDT', time: '10:00:11', positionId: 'pos-eth' },
{ id: 'act-a09', kind: 'reject', title: 'Signal rejected', detail: 'Received 94 s after candle close (limit 30 s)', accountId: 'acct-a', strategyId: 'meanrev-1h', pair: 'BTCUSDT', time: '11:01:34' },
{ id: 'act-a10', kind: 'take-profit', title: 'Partial take profit filled', detail: '1.25 SOL at 168.00 · +10.00 USDT gross', accountId: 'acct-a', strategyId: 'momentum-15m', pair: 'SOLUSDT', time: '11:42:18', positionId: 'pos-sol' },
{ id: 'act-a11', kind: 'protection', title: 'Stop resized after partial exit', detail: 'Remaining 2.50 SOL · awaiting confirmation', accountId: 'acct-a', strategyId: 'momentum-15m', pair: 'SOLUSDT', time: '11:42:25', positionId: 'pos-sol' },
{ id: 'act-a12', kind: 'skip', title: 'Signal skipped', detail: 'Maximum open positions (3) reached', accountId: 'acct-a', strategyId: 'momentum-15m', pair: 'ETHUSDT', time: '12:15:02' },
{ id: 'act-a13', kind: 'trailing', title: 'Trailing stop armed', detail: 'Activates at 64,500.0', accountId: 'acct-a', strategyId: 'trend-4h', pair: 'BTCUSDT', time: '12:30:40', positionId: 'pos-btc' },
{ id: 'act-b01', kind: 'stop-loss', title: 'Stop loss filled', detail: 'Long closed at stop · −12.00 USDT gross', accountId: 'acct-b', strategyId: 'meanrev-1h', pair: 'SOLUSDT', time: '06:40:12' },
{ id: 'act-b02', kind: 'entry', title: 'Paper entry filled', detail: 'Long 0.16 ETH at 3,125.00 · 10×', accountId: 'acct-b', strategyId: 'trend-4h', pair: 'ETHUSDT', time: '04:00:04', positionId: 'pos-b-eth' },
{ id: 'act-b03', kind: 'protection', title: 'Protective stop confirmed', detail: 'Stop 3,060.00 · Target 3,260.00', accountId: 'acct-b', strategyId: 'trend-4h', pair: 'ETHUSDT', time: '04:00:08', positionId: 'pos-b-eth' },
{ id: 'act-b04', kind: 'entry', title: 'Paper entry filled', detail: 'Short 0.0032 BTC at 62,500.0 · 5×', accountId: 'acct-b', strategyId: 'meanrev-1h', pair: 'BTCUSDT', time: '09:00:04', positionId: 'pos-b-btc' },
{ id: 'act-b05', kind: 'protection', title: 'Protective stop confirmed', detail: 'Stop 65,000.0 · Target 60,800.0', accountId: 'acct-b', strategyId: 'meanrev-1h', pair: 'BTCUSDT', time: '09:00:09', positionId: 'pos-b-btc' },
{ id: 'act-b06', kind: 'skip', title: 'Signal skipped', detail: 'Maximum open positions (2) reached', accountId: 'acct-b', strategyId: 'momentum-15m', pair: 'SOLUSDT', time: '12:15:02' }];


export const signals: SignalRecord[] = [
{ id: 'sig-a1', accountId: 'acct-a', strategyId: 'meanrev-1h', pair: 'ETHUSDT', action: 'Close short', timeframe: '1H', candleCloseAt: '04:00:00', receivedAt: '04:00:03', result: 'executed', reason: 'Paper exit filled at 3,073.33' },
{ id: 'sig-a2', accountId: 'acct-a', strategyId: 'trend-4h', pair: 'BTCUSDT', action: 'Open long', timeframe: '4H', candleCloseAt: '08:00:00', receivedAt: '08:00:02', result: 'executed', reason: 'Paper entry filled at 62,500.0' },
{ id: 'sig-a3', accountId: 'acct-a', strategyId: 'momentum-15m', pair: 'SOLUSDT', action: 'Open long', timeframe: '15m', candleCloseAt: '09:15:00', receivedAt: '09:15:02', result: 'executed', reason: 'Paper entry filled at 160.00' },
{ id: 'sig-a4', accountId: 'acct-a', strategyId: 'meanrev-1h', pair: 'ETHUSDT', action: 'Open short', timeframe: '1H', candleCloseAt: '10:00:00', receivedAt: '10:00:03', result: 'executed', reason: 'Paper entry filled at 3,200.00' },
{ id: 'sig-a5', accountId: 'acct-a', strategyId: 'meanrev-1h', pair: 'BTCUSDT', action: 'Open short', timeframe: '1H', candleCloseAt: '11:00:00', receivedAt: '11:01:34', result: 'rejected', reason: 'Stale signal — received 94 s after candle close (limit 30 s)' },
{ id: 'sig-a6', accountId: 'acct-a', strategyId: 'momentum-15m', pair: 'ETHUSDT', action: 'Open long', timeframe: '15m', candleCloseAt: '12:15:00', receivedAt: '12:15:02', result: 'skipped', reason: 'Maximum open positions (3) reached' },
{ id: 'sig-b1', accountId: 'acct-b', strategyId: 'trend-4h', pair: 'ETHUSDT', action: 'Open long', timeframe: '4H', candleCloseAt: '04:00:00', receivedAt: '04:00:03', result: 'executed', reason: 'Paper entry filled at 3,125.00' },
{ id: 'sig-b2', accountId: 'acct-b', strategyId: 'meanrev-1h', pair: 'BTCUSDT', action: 'Open short', timeframe: '1H', candleCloseAt: '09:00:00', receivedAt: '09:00:02', result: 'executed', reason: 'Paper entry filled at 62,500.0' },
{ id: 'sig-b3', accountId: 'acct-b', strategyId: 'momentum-15m', pair: 'SOLUSDT', action: 'Open long', timeframe: '15m', candleCloseAt: '12:15:00', receivedAt: '12:15:02', result: 'skipped', reason: 'Maximum open positions (2) reached' }];


export const notifications: NotificationItem[] = [
{ id: 'ntf-1', title: 'Signal skipped', detail: 'ETHUSDT · Demo Account A · Maximum open positions (3) reached', time: '12:15:02', read: false, tone: 'warning' },
{ id: 'ntf-2', title: 'Partial take profit filled', detail: 'SOLUSDT · Demo Account A · 1.25 SOL at 168.00', time: '11:42:18', read: false, tone: 'success' },
{ id: 'ntf-3', title: 'Signal rejected', detail: 'BTCUSDT · Demo Account A · Received 94 s after candle close', time: '11:01:34', read: true, tone: 'warning' },
{ id: 'ntf-4', title: 'Protective stop confirmed', detail: 'ETHUSDT · Demo Account A · Stop 3,260.00', time: '10:00:11', read: true, tone: 'info' }];


export const connectionEvents: ConnectionEvent[] = [
{ id: 'evt-a1', accountId: 'acct-a', at: DEMO_START_MS - 12 * DAY, action: 'Connection created', outcome: 'success', detail: 'MEXC Futures · Paper simulation · key DEMO-••••-A7Q2' },
{ id: 'evt-a2', accountId: 'acct-a', at: DEMO_START_MS - 6 * HOUR, action: 'Validation completed', outcome: 'success', detail: '7 of 7 simulated checks passed' },
{ id: 'evt-a3', accountId: 'acct-a', at: DEMO_START_MS - 8000, action: 'Synchronization completed', outcome: 'success', detail: 'Balances and 3 open positions reconciled' },
{ id: 'evt-b1', accountId: 'acct-b', at: DEMO_START_MS - 5 * DAY, action: 'Connection created', outcome: 'success', detail: 'MEXC Futures · Paper simulation · key DEMO-••••-K4M9' },
{ id: 'evt-b2', accountId: 'acct-b', at: DEMO_START_MS - 2 * DAY, action: 'Preferences changed', outcome: 'info', detail: 'Preferred leverage 10× → 5×' },
{ id: 'evt-b3', accountId: 'acct-b', at: DEMO_START_MS - 5 * HOUR, action: 'Validation completed', outcome: 'success', detail: '7 of 7 simulated checks passed' },
{ id: 'evt-b4', accountId: 'acct-b', at: DEMO_START_MS - 11000, action: 'Synchronization completed', outcome: 'success', detail: 'Balances and 2 open positions reconciled' }];


export const signalServiceHealth: HealthService = {
  id: 'signal-service',
  name: 'Central signal service',
  state: 'operational',
  statusLabel: 'Receiving',
  detail: 'Last alert 12:15:02 · 1 late alert today'
};

/** Last value of every series is replaced at render time by the live computed equity. */
export const equitySeries: Record<string, EquitySeriesSet> = {
  'acct-a': {
    today: [5000.0, 4996.2, 5004.8, 5011.4, 5008.9, 5023.6, 5047.3, 5061.1, 5055.4, 5078.2, 5096.8, 5110.3, 5124.7, 5131.9, 5142.5],
    '7d': [4812.4, 4856.1, 4838.7, 4901.3, 4947.8, 5000.0, 5142.5],
    '30d': [
    4520.0, 4541.3, 4533.8, 4567.2, 4589.6, 4574.1, 4602.9, 4631.5, 4618.2, 4655.7,
    4672.4, 4660.8, 4694.3, 4711.9, 4703.2, 4738.6, 4752.1, 4745.3, 4769.8, 4781.2,
    4774.6, 4798.9, 4805.3, 4812.4, 4856.1, 4838.7, 4901.3, 4947.8, 5000.0, 5142.5]

  },
  'acct-b': {
    today: [2500.0, 2502.1, 2497.4, 2494.8, 2499.6, 2491.3, 2486.7, 2489.2, 2483.9, 2480.4, 2482.7, 2485.1, 2487.3, 2485.6, 2484.2],
    '7d': [2462.3, 2471.8, 2468.4, 2479.9, 2491.2, 2500.0, 2484.2],
    '30d': [
    2410.0, 2414.2, 2409.8, 2421.5, 2426.1, 2419.7, 2431.4, 2437.9, 2433.2, 2442.6,
    2448.1, 2444.3, 2451.8, 2449.2, 2455.6, 2453.1, 2458.7, 2456.4, 2460.9, 2458.2,
    2463.5, 2459.8, 2461.1, 2462.3, 2471.8, 2468.4, 2479.9, 2491.2, 2500.0, 2484.2]

  }
};