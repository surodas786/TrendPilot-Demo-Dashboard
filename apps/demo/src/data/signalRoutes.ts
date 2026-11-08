import { DEMO_START_MS } from './mockData';
import type { RouteTriggerType, RouteUsage, SignalAction, SignalRoute } from '../types/signals';

/** Disclosed simulation tolerance for timestamps ahead of the simulation clock. */
export const FUTURE_TOLERANCE_SEC = 5;
export const ROUTE_ENDPOINT_NOTE = 'Simulation route — no public endpoint';
/** Fixed simulated spread used during account evaluation. */
export const SIM_SPREAD_PCT = 0.04;

export const ACTION_LABELS: Record<SignalAction, string> = {
  'open-long': 'Open long',
  'open-short': 'Open short',
  'close-long': 'Close long',
  'close-short': 'Close short'
};

export const ACTION_CODES: Record<SignalAction, string> = {
  'open-long': 'OPEN_LONG',
  'open-short': 'OPEN_SHORT',
  'close-long': 'CLOSE_LONG',
  'close-short': 'CLOSE_SHORT'
};

export const ALL_ACTIONS: SignalAction[] = ['open-long', 'open-short', 'close-long', 'close-short'];

export const isEntryAction = (a: SignalAction) => a === 'open-long' || a === 'open-short';

export const ROUTE_TIMEFRAMES = ['5m', '15m'] as const;
export const ROUTE_TIMEFRAME_LABELS: Record<string, string> = { '5m': '5 minutes (5m)', '15m': '15 minutes (15m)' };
export const USAGE_LABELS: Record<RouteUsage, string> = { trade: 'Trade trigger', info: 'Information only' };
export const USAGE_DESCRIPTIONS: Record<RouteUsage, string> = {
  trade: 'Send the signal to eligible strategy packages for evaluation.',
  info: 'Show the signal in the Central Signal Feed without opening, closing or reversing trades.'
};
export const SUPERTREND_STRATEGY_ID = 'supertrend-15m';

export const routeTriggerType = (r: SignalRoute): RouteTriggerType => r.triggerType ?? 'supertrend';
export const routeUsage = (r: SignalRoute): RouteUsage => r.usage ?? 'trade';
export function routeTriggerName(r: SignalRoute): string {
  return routeTriggerType(r) === 'custom' ? r.triggerName?.trim() || 'Other TradingView alert' : 'Supertrend';
}
export const timeframeMinutes = (tf: string) => tf === '5m' ? 5 : 15;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'alert';

/** Strategy identifier sent for a route. Custom alerts never carry the Supertrend identifier. */
export function strategyIdFor(type: RouteTriggerType, name: string): string {
  return type === 'custom' ? `custom-${slug(name)}` : SUPERTREND_STRATEGY_ID;
}

/** Blank route draft with the existing Supertrend route's controls as a starting point. */
export function newRouteDraft(at: number, base: SignalRoute): SignalRoute {
  return {
    ...base,
    id: `sim-route-${at.toString(36)}`,
    label: '',
    enabled: true,
    symbolMap: { ...base.symbolMap },
    allowedActions: [...base.allowedActions],
    timeframe: '5m',
    triggerType: 'custom',
    triggerName: '',
    usage: 'trade',
    strategyId: strategyIdFor('custom', ''),
    updatedAt: at
  };
}

export const seedRoutes: SignalRoute[] = [
{
  id: 'sim-route-st15-001',
  label: 'Supertrend 15m → MEXC paper',
  enabled: true,
  strategyId: 'supertrend-15m',
  approvedVersion: '1.0',
  sourceExchange: 'MEXC',
  symbolMap: { 'BTCUSDT.P': 'BTCUSDT', 'ETHUSDT.P': 'ETHUSDT', 'SOLUSDT.P': 'SOLUSDT' },
  marketType: 'perpetual',
  timeframe: '15m',
  allowedActions: [...ALL_ACTIONS],
  maxSignalAgeSec: 30,
  closeMaxSignalAgeSec: 300,
  requireConfirmed: true,
  acceptEntries: true,
  acceptCloses: true,
  updatedAt: DEMO_START_MS - 24 * 3600000,
  triggerType: 'supertrend',
  usage: 'trade'
}];