import { z } from 'zod';
import { Decimal } from './decimal';
import { directionPermitted, type BlockStatus, type Direction, type Mode } from './orderBlock';
import { entryGate, OUTSIDE_WINDOW_TEXT, type TradingWindow } from './tradingWindow';
import type { Weekday } from './weekdays';

/**
 * SRS §6 TradingView intake (SIG-01…SIG-05) and the per-investor routing decision of the
 * first M2 slice. Pure functions only; persistence lives in @trendpilot/db.
 */

export const SIGNAL_ACTIONS = ['BULLISH_FLIP', 'BEARISH_FLIP', 'CLOSE_LONG', 'CLOSE_SHORT'] as const;
export type SignalAction = (typeof SIGNAL_ACTIONS)[number];
export const SIGNAL_INTERVALS = ['5', '15'] as const;
export type SignalInterval = (typeof SIGNAL_INTERVALS)[number];
export const ROUTE_KINDS = ['ACTIONABLE', 'INFO_ONLY'] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

/** Interval string → strategy timeframe. */
export const INTERVAL_TIMEFRAME: Record<SignalInterval, '5m' | '15m'> = { '5': '5m', '15': '15m' };

/** UTC ISO-8601 as TradingView renders {{time}} / {{timenow}}, e.g. 2026-11-08T09:15:00Z. */
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const PLACEHOLDER = /\{\{[^}]*\}\}/;

const tvString = (field: string) =>
  z
    .string({ error: `${field} must be a string.` })
    .trim()
    .min(1, `${field} is required.`)
    .max(64, `${field} is too long.`)
    .refine((v) => !PLACEHOLDER.test(v), `${field} contains an unresolved TradingView placeholder.`);

const utcTimestamp = (field: string) =>
  tvString(field)
    .refine((v) => UTC_ISO.test(v) && !Number.isNaN(Date.parse(v)), `${field} must be a UTC timestamp like 2026-11-08T09:15:00Z.`)
    .transform((v) => new Date(v));

/**
 * SIG-02: the exact alert message. Strict: unknown keys (e.g. investor identifiers or
 * credentials) are rejected rather than ignored.
 */
export const tradingViewPayloadSchema = z
  .object({
    action: z.enum(SIGNAL_ACTIONS, { error: 'action must be BULLISH_FLIP, BEARISH_FLIP, CLOSE_LONG or CLOSE_SHORT.' }),
    source_exchange: tvString('source_exchange'),
    source_symbol: tvString('source_symbol'),
    interval: z.enum(SIGNAL_INTERVALS, { error: 'interval must be "5" or "15".' }),
    bar_open_utc: utcTimestamp('bar_open_utc'),
    alert_fired_utc: utcTimestamp('alert_fired_utc'),
    reference_price: tvString('reference_price')
      .refine((v) => /^\d{1,20}(\.\d{1,12})?$/.test(v) && new Decimal(v).gt(0), 'reference_price must be a positive decimal.')
  })
  .strict();

export type TradingViewPayload = z.output<typeof tradingViewPayloadSchema>;

/** SIG-03: normalise the source tuple to the registered route format. */
export const normalizeSource = (value: string) => value.trim().toUpperCase();

/** Ingress rejection reasons (persisted, never per-investor). */
export type SignalRejectReason =
  | 'MALFORMED'
  | 'ROUTE_NOT_FOUND'
  | 'ROUTE_AMBIGUOUS'
  | 'MISALIGNED_BAR'
  | 'PRE_CLOSE'
  | 'FUTURE_TIMESTAMP'
  | 'SIGNAL_STALE'
  | 'OUT_OF_ORDER'
  | 'CONFLICTING_SAME_BAR';

export interface TimingPolicy {
  /** Max age of the bar close at receipt. Route-configured; investors' strategy versions are rechecked later. */
  maxSignalAgeSeconds: number;
  /** Allowed clock skew between TradingView and the server. */
  clockToleranceSeconds: number;
}

export interface SignalTimes {
  barOpenAt: Date;
  barCloseAt: Date;
  alertFiredAt: Date;
  receivedAt: Date;
}

/**
 * SIG-03 timing: candle alignment, derived bar close, pre-close, future and stale checks.
 * Returns the derived times or the first violated rule.
 */
export function assessTiming(
  p: Pick<TradingViewPayload, 'bar_open_utc' | 'alert_fired_utc' | 'interval'>,
  receivedAt: Date,
  policy: TimingPolicy
): { ok: true; times: SignalTimes } | { ok: false; reason: SignalRejectReason; message: string } {
  const intervalMs = Number(p.interval) * 60_000;
  const open = p.bar_open_utc.getTime();
  if (open % intervalMs !== 0) return { ok: false, reason: 'MISALIGNED_BAR', message: `bar_open_utc is not aligned to a ${p.interval}-minute candle.` };
  const close = open + intervalMs;
  const fired = p.alert_fired_utc.getTime();
  const received = receivedAt.getTime();
  const tol = policy.clockToleranceSeconds * 1000;
  if (fired < close - tol) return { ok: false, reason: 'PRE_CLOSE', message: 'The alert fired before the bar closed. Use "Once Per Bar Close".' };
  if (fired > received + tol || close > received + tol) return { ok: false, reason: 'FUTURE_TIMESTAMP', message: 'The alert or bar close is in the future.' };
  if (received - close > policy.maxSignalAgeSeconds * 1000) {
    return { ok: false, reason: 'SIGNAL_STALE', message: `The bar closed more than ${policy.maxSignalAgeSeconds}s before receipt.` };
  }
  return { ok: true, times: { barOpenAt: new Date(open), barCloseAt: new Date(close), alertFiredAt: new Date(fired), receivedAt } };
}

/** Signal stream: one source chart and interval. Directional ordering is enforced per stream. */
export const streamKey = (exchange: string, symbol: string, interval: string) => `${exchange}|${symbol}|${interval}`;

export const isDirectional = (a: SignalAction) => a === 'BULLISH_FLIP' || a === 'BEARISH_FLIP';
export const oppositeAction = (a: SignalAction): SignalAction | null => (a === 'BULLISH_FLIP' ? 'BEARISH_FLIP' : a === 'BEARISH_FLIP' ? 'BULLISH_FLIP' : null);

/* ─────────────────────── Per-investor decision (this slice) ─────────────────────── */

/**
 * §10.1 decision reasons used so far. READY_FOR_EVALUATION is NOT an approved entry and
 * NOT a fill: EMA, market data, risk, sizing and position checks run in later M2 slices.
 */
export type DecisionReason =
  | 'ACCOUNT_SUSPENDED'
  | 'LIVE_DISABLED'
  | 'PAUSED'
  | 'STRATEGY_MISMATCH'
  | 'DIRECTION_DISABLED'
  | 'DAY_DISABLED'
  | 'OUTSIDE_TRADING_WINDOW'
  | 'SIGNAL_STALE'
  | 'NO_MANAGED_POSITION';

export type DecisionStatus = 'READY_FOR_EVALUATION' | 'SKIPPED';

export const DECISION_REASON_TEXT: Record<DecisionReason, string> = {
  ACCOUNT_SUSPENDED: 'Your account is not active.',
  LIVE_DISABLED: 'Live trading was disabled in the build that evaluated this signal.',
  PAUSED: 'This order block is paused.',
  STRATEGY_MISMATCH: 'The signal interval does not match the strategy version this block is pinned to.',
  DIRECTION_DISABLED: 'This direction is not enabled for the block or its strategy.',
  DAY_DISABLED: 'New entries are not allowed on this weekday.',
  OUTSIDE_TRADING_WINDOW: `${OUTSIDE_WINDOW_TEXT}.`,
  SIGNAL_STALE: 'The signal was too old by the time it was evaluated.',
  NO_MANAGED_POSITION: 'Close signals only act on a managed position; there is none.'
};

export interface BlockEvaluationInput {
  action: SignalAction;
  interval: SignalInterval;
  barCloseAt: Date;
  evaluatedAt: Date;
  user: { status: 'ACTIVE' | 'SUSPENDED' | 'INVITED' };
  block: { status: BlockStatus; mode: Mode; direction: Direction; weekdays: Weekday[]; timezone: string; tradingWindow?: TradingWindow | null };
  version: { timeframe: '5m' | '15m'; permittedDirections: Direction; signalMaxAgeSeconds: number };
}

export interface BlockEvaluation {
  status: DecisionStatus;
  /** First failed check in a fixed order, or null when ready. */
  reason: DecisionReason | null;
  /** Every failed check, for transparency. */
  failed: DecisionReason[];
  side: 'LONG' | 'SHORT' | null;
  signalAgeSeconds: number;
}

/**
 * Checks that need no market data, run independently for each matching block. Any failure
 * skips only this investor's block; it never affects another investor (SIG-05).
 */
export function evaluateBlockForSignal(i: BlockEvaluationInput): BlockEvaluation {
  const failed: DecisionReason[] = [];
  const side = i.action === 'BULLISH_FLIP' ? 'LONG' : i.action === 'BEARISH_FLIP' ? 'SHORT' : null;
  const ageSeconds = Math.max(0, Math.round((i.evaluatedAt.getTime() - i.barCloseAt.getTime()) / 1000));

  if (i.user.status !== 'ACTIVE') failed.push('ACCOUNT_SUSPENDED');
  // LIVE blocks pass the routing screen; their entries are gated by the Live rules (live.ts) at
  // evaluation and again in the worker. LIVE_DISABLED remains only for decisions recorded earlier.
  if (i.block.status !== 'ACTIVE') failed.push('PAUSED');
  if (INTERVAL_TIMEFRAME[i.interval] !== i.version.timeframe) failed.push('STRATEGY_MISMATCH');

  if (side === null) {
    // STR-05: explicit closes act only on a managed position. Positions arrive with paper execution.
    failed.push('NO_MANAGED_POSITION');
  } else {
    const wanted: Direction = side === 'LONG' ? 'LONG_ONLY' : 'SHORT_ONLY';
    if (!directionPermitted(wanted, i.block.direction) || !directionPermitted(wanted, i.version.permittedDirections)) failed.push('DIRECTION_DISABLED');
    // CFG-04: trading window and the weekday its session started on, at evaluation; both are
    // checked again at submission.
    const gate = entryGate(i.block.weekdays, i.block.tradingWindow, i.evaluatedAt, i.block.timezone);
    if (!gate.ok) failed.push(gate.reason);
    // Recheck freshness after any queue delay against the pinned version's expiry.
    if (ageSeconds > i.version.signalMaxAgeSeconds) failed.push('SIGNAL_STALE');
  }

  return { status: failed.length ? 'SKIPPED' : 'READY_FOR_EVALUATION', reason: failed[0] ?? null, failed, side, signalAgeSeconds: ageSeconds };
}

/** Admin route configuration (UI-05 Signal Routes). */
export const signalRouteCreateSchema = z
  .object({
    name: z.string().trim().min(3).max(80),
    sourceExchange: z.string().trim().min(1).max(32).transform(normalizeSource),
    sourceSymbol: z.string().trim().min(1).max(48).transform(normalizeSource),
    interval: z.enum(SIGNAL_INTERVALS),
    action: z.enum(SIGNAL_ACTIONS),
    kind: z.enum(ROUTE_KINDS),
    instrumentId: z.uuid(),
    packageId: z.uuid(),
    maxSignalAgeSeconds: z.number().int().min(10).max(3600),
    clockToleranceSeconds: z.number().int().min(0).max(60)
  })
  .strict();
export type SignalRouteCreate = z.output<typeof signalRouteCreateSchema>;

export const signalRouteUpdateSchema = z.object({ enabled: z.boolean() }).strict();

/** TradingView renders {{time}} / {{timenow}} without milliseconds. */
export const tvTime = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Start of the most recently closed bar at `now` for an interval. */
export function lastClosedBarOpen(now: Date, interval: SignalInterval): Date {
  const ms = Number(interval) * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms - ms);
}

/**
 * The exact SIG-02 alert message with placeholders resolved, keys in template order.
 * Used by the replay command and tests so they send precisely what TradingView sends.
 */
export function buildTradingViewPayload(i: {
  action: SignalAction;
  exchange: string;
  symbol: string;
  interval: SignalInterval;
  barOpen: Date;
  firedAt: Date;
  referencePrice: string;
}): Record<string, string> {
  return {
    action: i.action,
    source_exchange: i.exchange,
    source_symbol: i.symbol,
    interval: i.interval,
    bar_open_utc: tvTime(i.barOpen),
    alert_fired_utc: tvTime(i.firedAt),
    reference_price: i.referencePrice
  };
}
