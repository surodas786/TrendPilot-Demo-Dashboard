import { ACTION_CODES, routeTriggerName, routeTriggerType, timeframeMinutes } from '../data/signalRoutes';
import { strategyTemplates } from '../data/strategyCatalog';
import { formatClock } from './clock';
import type { SignalAction, SignalInput, SignalPayload, SignalRoute } from '../types/signals';

const DHAKA_OFFSET_MS = 6 * 3600000;

/** Common demo webhook — the same address for LONG and SHORT alerts on every route. */
export function commonWebhookUrl(): string {
  return `${window.location.origin}/demo-webhook/common-signals`;
}

/** ISO 8601 timestamp in Asia/Dhaka (+06:00, no daylight saving). */
export function isoDhaka(ms: number): string {
  return new Date(ms + DHAKA_OFFSET_MS).toISOString().replace('Z', '+06:00');
}

/** "14:30:03.120" — clock time with milliseconds for latency views. */
export function preciseClock(ms: number): string {
  return `${formatClock(ms)}.${String(Math.floor((ms % 1000 + 1000) % 1000)).padStart(3, '0')}`;
}

/** Close time of the latest completed candle at or before `now` (candles align to UTC boundaries). */
export function latestCandleClose(now: number, back = 0, minutes = 15): number {
  const ms = minutes * 60 * 1000;
  return Math.floor(now / ms) * ms - back * ms;
}

export function sourceSymbolFor(route: SignalRoute | undefined, pair: string): string | null {
  if (!route) return null;
  return Object.keys(route.symbolMap).find((k) => route.symbolMap[k] === pair) ?? null;
}

/** Signal-ID prefix per route: SIM-ST15 for Supertrend 15m, SIM-TV5 for a custom 5m alert, etc. */
function idPrefix(route: SignalRoute | undefined): string {
  if (!route) return 'SIM-ST15';
  return `SIM-${routeTriggerType(route) === 'custom' ? 'TV' : 'ST'}${timeframeMinutes(route.timeframe)}`;
}

let idSeq = 0;
export function makeSignalId(pair: string, action: SignalAction, candleCloseAt: number, route?: SignalRoute): string {
  idSeq += 1;
  const hhmm = formatClock(candleCloseAt).slice(0, 5).replace(':', '');
  return `${idPrefix(route)}-${pair.replace('USDT', '')}-${hhmm}-${ACTION_CODES[action].replace('_', '')}-${(Date.now() % 100000).toString(36).toUpperCase()}${idSeq}`;
}

export function buildPayload(input: SignalInput, route: SignalRoute | undefined): SignalPayload {
  return {
    signal_id: input.signalId,
    route_id: input.routeId,
    strategy_id: route?.strategyId ?? 'unknown',
    strategy_version: input.strategyVersion,
    alert_trigger: route ? routeTriggerName(route) : 'unknown',
    source_exchange: route?.sourceExchange ?? 'unknown',
    source_symbol: sourceSymbolFor(route, input.pair) ?? 'unmapped',
    market_type: route?.marketType ?? 'unknown',
    timeframe: route?.timeframe ?? 'unknown',
    interval: input.timeframe ?? '',
    action: ACTION_CODES[input.action],
    candle_close_time: Number.isFinite(input.candleCloseAt) ? isoDhaka(input.candleCloseAt) : 'invalid',
    signal_created_at: Number.isFinite(input.createdAt) ? isoDhaka(input.createdAt) : 'invalid',
    reference_price: input.referencePrice,
    confirmed: input.confirmed
  };
}

/** A valid default signal for the route's latest completed candle, timestamps from the simulation clock. */
export function defaultSignalInput(route: SignalRoute, pair: string, action: SignalAction, price: number, now: number, candlesBack = 0): SignalInput {
  const candle = latestCandleClose(now, candlesBack, timeframeMinutes(route.timeframe));
  return {
    routeId: route.id,
    strategyVersion: route.approvedVersion || strategyTemplates[0].version,
    pair,
    action,
    referencePrice: price,
    candleCloseAt: candle,
    createdAt: candle + 1200,
    receivedAt: candle + 2600,
    confirmed: true,
    signalId: makeSignalId(pair, action, candle, route),
    timeframe: route.timeframe
  };
}

/**
 * Paste-ready TradingView alert message. The route ID is filled in; TradingView placeholders
 * ({{ticker}}, {{interval}}, {{timenow}}, {{close}}) are left exactly as written so TradingView fills them.
 */
export function tradingViewAlertMessage(route: SignalRoute, side: 'LONG' | 'SHORT'): string {
  return [
  '{',
  `  "route_id": "${route.id}",`,
  `  "signal_id": "${route.id}-{{ticker}}-{{interval}}-{{time}}-${side}",`,
  '  "symbol": "{{ticker}}",',
  '  "exchange": "{{exchange}}",',
  '  "interval": "{{interval}}",',
  `  "action": "${side}",`,
  '  "timestamp": "{{timenow}}",',
  '  "bar_time": "{{time}}"',
  '}'].
  join('\n');
}