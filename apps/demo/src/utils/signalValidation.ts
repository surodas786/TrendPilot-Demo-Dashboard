import { ACTION_LABELS, ALL_ACTIONS, FUTURE_TOLERANCE_SEC, isEntryAction, routeTriggerName, routeTriggerType } from '../data/signalRoutes';
import { normalizeInterval } from './platformText';
import { strategyTemplates } from '../data/strategyCatalog';
import { formatClock } from './clock';
import { sourceSymbolFor } from './signalPayload';
import type { CentralSignal, SignalAction, SignalCheck, SignalInput, SignalRoute, ValidationOutcome } from '../types/signals';

export type Watermarks = Record<string, {candleAt: number;actions: SignalAction[];}>;

export interface ValidationResult {
  checks: SignalCheck[];
  outcome: ValidationOutcome;
  reason: string;
  duplicateOf?: string;
  route: SignalRoute | undefined;
  sourceSymbol: string | null;
  /** Candle close → gateway receipt, seconds. */
  ageSec: number;
}

export const watermarkKey = (strategyId: string, version: string, pair: string) => `${strategyId}@${version}:${pair}`;

const SIGNAL_ID_RE = /^[A-Za-z0-9._:-]{4,80}$/;

/**
 * Explicit, ordered validation of one receipt. Pure — never changes state, so
 * "Validate only" and dispatch share exactly the same checks.
 */
export function validateSignal(input: SignalInput, ctx: {routes: SignalRoute[];signals: CentralSignal[];watermarks: Watermarks;now: number;}): ValidationResult {
  const checks: SignalCheck[] = [];
  const add = (id: string, label: string, status: SignalCheck['status'], detail: string) => checks.push({ id, label, status, detail });
  const route = ctx.routes.find((r) => r.id === input.routeId);
  const sourceSymbol = sourceSymbolFor(route, input.pair);
  const entry = isEntryAction(input.action);
  const times = [input.candleCloseAt, input.createdAt, input.receivedAt];
  const timesValid = times.every((t) => Number.isFinite(t) && t > 0);

  // 1. Required fields and data types
  {
    const problems: string[] = [];
    if (!input.signalId || !SIGNAL_ID_RE.test(input.signalId)) problems.push('signal_id must be 4–80 characters (letters, digits, . _ : -)');
    if (!ALL_ACTIONS.includes(input.action)) problems.push('action is not a recognised value');
    if (!Number.isFinite(input.referencePrice) || input.referencePrice <= 0) problems.push('reference_price must be a number above 0');
    if (!timesValid) problems.push('timestamps must be valid times');
    if (typeof input.confirmed !== 'boolean') problems.push('confirmed must be true or false');
    if (!input.strategyVersion) problems.push('strategy_version is required');
    add('fields', 'Required fields and data types', problems.length ? 'fail' : 'pass', problems.length ? problems.join(' · ') : 'All 12 payload fields present with valid types');
  }

  // 2. Known route
  if (!route) add('route', 'Known route', 'fail', `Route ${input.routeId || '(empty)'} is not configured`);else
  if (!route.enabled) add('route', 'Known route', 'fail', `${route.label} is disabled`);else
  add('route', 'Known route', 'pass', `${route.label} · ${route.id}`);

  // 3. Approved strategy version (custom TradingView alerts have no strategy template)
  if (!route) add('version', 'Approved strategy version', 'skip', 'Route unknown');else
  if (routeTriggerType(route) === 'custom') {
    if (input.strategyVersion !== route.approvedVersion) add('version', 'Approved strategy version', 'fail', `Version ${input.strategyVersion || '—'} is not the approved version ${route.approvedVersion} for this route`);else
    add('version', 'Approved strategy version', 'pass', `${routeTriggerName(route)} (custom alert) v${route.approvedVersion}`);
  } else {
    const template = strategyTemplates.find((t) => t.id === route.strategyId && t.version === input.strategyVersion);
    if (input.strategyVersion !== route.approvedVersion || !template) add('version', 'Approved strategy version', 'fail', `Version ${input.strategyVersion || '—'} is not the approved version ${route.approvedVersion} for this route`);else
    add('version', 'Approved strategy version', 'pass', `${template.name} v${template.version}`);
  }

  // 4. Symbol mapping
  if (!route) add('symbol', 'Symbol mapping', 'skip', 'Route unknown');else
  if (!sourceSymbol) add('symbol', 'Symbol mapping', 'fail', `No source symbol maps to ${input.pair} on this route`);else
  add('symbol', 'Symbol mapping', 'pass', `${route.sourceExchange}:${sourceSymbol} → ${input.pair}`);

  // 5. Supported market, timeframe and action
  if (!route) add('market', 'Market, timeframe and action', 'skip', 'Route unknown');else
  {
    const label = 'Market, timeframe and action';
    if (route.marketType !== 'perpetual') add('market', label, 'fail', 'Only USDT perpetual futures are supported');else
    if (!route.allowedActions.includes(input.action)) add('market', label, 'fail', `${ACTION_LABELS[input.action]} is not allowed on this route`);else
    if (entry && !route.acceptEntries) add('market', label, 'fail', 'Route is not accepting new entry signals');else
    if (!entry && !route.acceptCloses) add('market', label, 'fail', 'Route is not accepting close signals');else
    add('market', label, 'pass', `USDT perpetual · ${route.timeframe} · ${ACTION_LABELS[input.action]} permitted`);
  }

  // 5b. Incoming timeframe (TradingView interval) must match the route
  if (!route) add('timeframe', 'Signal timeframe', 'skip', 'Route unknown');else
  {
    const tf = normalizeInterval(input.timeframe).timeframe;
    if (!input.timeframe) add('timeframe', 'Signal timeframe', 'fail', 'Signal timeframe missing — the interval field is empty');else
    if (tf !== route.timeframe) add('timeframe', 'Signal timeframe', 'fail', `Timeframe mismatch — signal ${tf ?? input.timeframe}, route ${route.timeframe}`);else
    add('timeframe', 'Signal timeframe', 'pass', `Signal ${tf} matches route ${route.timeframe}`);
  }

  // 6. Completed-candle confirmation
  if (route?.requireConfirmed && !input.confirmed) add('confirmed', 'Completed-candle confirmation', 'fail', 'Unconfirmed candle — the route requires a completed-candle signal');else
  add('confirmed', 'Completed-candle confirmation', 'pass', input.confirmed ? 'Candle confirmed closed' : 'Not required by this route');

  // 7. Timestamp order
  if (!timesValid) add('order', 'Timestamp order', 'skip', 'Invalid timestamps');else
  if (!(input.candleCloseAt <= input.createdAt && input.createdAt <= input.receivedAt)) {
    add('order', 'Timestamp order', 'fail', 'Expected candle close ≤ signal creation ≤ gateway receipt');
  } else add('order', 'Timestamp order', 'pass', `${formatClock(input.candleCloseAt)} ≤ ${formatClock(input.createdAt)} ≤ ${formatClock(input.receivedAt)}`);

  // 8. Future timestamps
  if (!timesValid) add('future', 'Future timestamps', 'skip', 'Invalid timestamps');else
  {
    const latest = Math.max(...times);
    const ahead = (latest - ctx.now) / 1000;
    if (ahead > FUTURE_TOLERANCE_SEC) add('future', 'Future timestamps', 'fail', `A timestamp is ${ahead.toFixed(1)} s ahead of the simulation clock (tolerance ${FUTURE_TOLERANCE_SEC} s)`);else
    add('future', 'Future timestamps', 'pass', `Within the ${FUTURE_TOLERANCE_SEC} s simulation tolerance`);
  }

  // 9. Maximum signal age — measured from candle close, so late creation cannot look fresh.
  const ageSec = timesValid ? (input.receivedAt - input.candleCloseAt) / 1000 : Number.NaN;
  if (!timesValid || !route) add('age', 'Maximum signal age', 'skip', !route ? 'Route unknown' : 'Invalid timestamps');else
  {
    const limit = entry ? route.maxSignalAgeSec : route.closeMaxSignalAgeSec;
    const policy = entry ? 'entry limit' : 'close-signal policy';
    const upstream = (input.createdAt - input.candleCloseAt) / 1000;
    if (ageSec > limit) add('age', 'Maximum signal age', 'fail', `Received ${ageSec.toFixed(1)} s after candle close (${policy} ${limit} s) · creation delay ${upstream.toFixed(1)} s`);else
    add('age', 'Maximum signal age', 'pass', `${ageSec.toFixed(1)} s from candle close to receipt (${policy} ${limit} s)`);
  }

  // 10. Duplicate signal ID
  const original = ctx.signals.find((s) => s.signalId === input.signalId && s.outcome !== 'duplicate');
  if (original) add('duplicate', 'Duplicate signal ID', 'fail', `Already received as ${original.id} at ${formatClock(original.receivedAt)} — no new dispatch`);else
  add('duplicate', 'Duplicate signal ID', 'pass', 'First receipt of this signal ID');

  // 11. Sequence watermark per strategy version and pair
  if (!route || !timesValid) add('sequence', 'Sequence (per version and pair)', 'skip', 'Route or timestamps invalid');else
  {
    const wm = ctx.watermarks[watermarkKey(route.strategyId, input.strategyVersion, input.pair)];
    const label = 'Sequence (per version and pair)';
    if (!wm) add('sequence', label, 'pass', 'No earlier accepted signal for this version and pair');else
    if (input.candleCloseAt < wm.candleAt) add('sequence', label, 'fail', `Out of order — candle ${formatClock(input.candleCloseAt)} is older than accepted ${formatClock(wm.candleAt)}`);else
    if (input.candleCloseAt === wm.candleAt) {
      const conflict =
      input.action === 'open-long' && wm.actions.includes('open-short') || input.action === 'open-short' && wm.actions.includes('open-long');
      if (wm.actions.includes(input.action)) add('sequence', label, 'fail', `${ACTION_LABELS[input.action]} already accepted for candle ${formatClock(wm.candleAt)}`);else
      if (conflict) add('sequence', label, 'fail', `Conflicts with the opposite opening signal accepted for candle ${formatClock(wm.candleAt)}`);else
      add('sequence', label, 'pass', `Distinct action on candle ${formatClock(wm.candleAt)}`);
    } else add('sequence', label, 'pass', `Newer than accepted ${formatClock(wm.candleAt)}`);
  }

  const firstFail = checks.find((c) => c.status === 'fail');
  const outcome: ValidationOutcome = original ? 'duplicate' : firstFail ? 'rejected' : 'accepted';
  return {
    checks,
    outcome,
    reason: original ? `Duplicate of ${original.id}` : firstFail ? firstFail.detail : 'All checks passed',
    duplicateOf: original?.id,
    route,
    sourceSymbol,
    ageSec
  };
}