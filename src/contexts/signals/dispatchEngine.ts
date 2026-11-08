import { ACTION_LABELS, isEntryAction, routeTriggerName, routeUsage, SIM_SPREAD_PCT } from '../../data/signalRoutes';
import { simulatedAtr } from '../../data/exitPlans';
import { ownerOf } from '../../data/demoUsers';
import { previewMarket, strategyTemplates } from '../../data/strategyCatalog';
import { summarizeAccount } from '../../utils/accountMath';
import { formatClock, timeToSeconds } from '../../utils/clock';
import { submissionBlockReason } from '../../utils/execution';
import { pendingEntriesFromOrders, reservedMarginFor } from '../../utils/orders';
import { runReadiness } from '../../utils/readiness';
import { computeRiskUsage, riskSettingsFor } from '../../utils/riskEngine';
import { buildPayload } from '../../utils/signalPayload';
import { validateSignal, watermarkKey } from '../../utils/signalValidation';
import { executionReducer } from '../executionReducer';
import { executeEntry } from './entryExecution';
import { makeActivity, makeNotification, nextSignalId, resultFor } from './signalHelpers';
import type { DemoState } from '../demoReducer';
import type { CentralSignal, Delivery, DeliveryState, SignalInput } from '../../types/signals';
import type { ReadinessItem } from '../../types/risk';
import type { Subscription } from '../../types/strategy';
import type { Direction, Position, SignalRecord } from '../../types/trading';

type Link = {to: string;label: string;};

/** Maps the first failing readiness check to a per-account outcome, readable reason and fix location. */
function outcomeForCheck(item: ReadinessItem): {state: DeliveryState;link?: Link;} {
  switch (item.id) {
    case 'status':
      return { state: 'skipped', link: { to: '/strategies', label: 'Open subscription' } };
    case 'exit-plan':
      return { state: 'skipped', link: { to: '/exit-settings', label: 'Open Exit Settings' } };
    case 'connection':
    case 'data':
      return { state: 'skipped', link: { to: '/exchange-connections', label: 'Open connection' } };
    case 'pauses':
      return { state: 'skipped', link: { to: '/exchange-connections', label: 'Review pauses' } };
    case 'pair':
      return { state: 'skipped', link: { to: '/strategies', label: 'Review pairs' } };
    case 'conflict':
      return { state: 'skipped', link: { to: '/positions-orders', label: 'View positions' } };
    default:
      return { state: 'rejected', link: { to: '/trading-risk', label: 'Review risk settings' } };
  }
}

function closeForSignal(s: DemoState, central: CentralSignal, p: Position, delivery: Delivery, kind: 'close' | 'opposite-close', prefix: string): {state: DemoState;delivery: Delivery;} {
  const at = delivery.evaluatedAt + 40;
  const requestId = `SIG-${central.id}-${p.id}`;
  let state = executionReducer(s, { type: 'submitClose', requestId, accountId: p.accountId, kind: 'full', items: [{ positionId: p.id, qty: p.quantity }], at });
  const item = state.closeRequests.find((r) => r.id === requestId)?.items[0];
  const map: Record<string, DeliveryState> = { filled: 'executed', 'partially-filled': 'partially-filled', unknown: 'unknown', failed: 'failed' };
  const st = item ? map[item.state] ?? 'failed' : 'failed';
  const label = kind === 'close' ? `Close signal ${central.signalId}` : `Opposite signal ${central.signalId}`;
  state = { ...state, tradeRecords: state.tradeRecords.map((t) => t.positionId === p.id && t.exitAt === at ? { ...t, exitReason: label } : t) };
  const filled = (item?.filledQty ?? 0) > 0;
  return {
    state,
    delivery: {
      ...delivery,
      kind,
      state: st,
      submittedAt: at,
      ackAt: st === 'failed' && !filled ? undefined : at + 120,
      firstFillAt: filled ? at : undefined,
      finalFillAt: st === 'executed' ? at : undefined,
      orderIds: item?.orderId ? [item.orderId] : [],
      positionId: p.id,
      reason: `${prefix}${st === 'executed' ? `Closed ${p.pair} ${p.direction} at ${item?.fillPrice}` : item?.reason ?? 'Close not completed'}`,
      link: { to: st === 'executed' ? '/trade-history' : '/positions-orders', label: st === 'executed' ? 'View trade history' : 'View position' }
    }
  };
}

function evaluateEntry(s: DemoState, central: CentralSignal, sub: Subscription, evalAt: number): {state: DemoState;delivery: Delivery;} {
  const account = s.accounts.find((a) => a.id === sub.accountId);
  const userId = ownerOf(account);
  const user = s.users.find((u) => u.id === userId);
  const direction: Direction = central.action === 'open-long' ? 'long' : 'short';
  const delivery: Delivery = { id: nextSignalId('DLV', evalAt), userId, accountId: sub.accountId, subscriptionId: sub.id, kind: 'entry', state: 'evaluating', reason: '', evaluatedAt: evalAt, orderIds: [] };
  const done = (state: DeliveryState, reason: string, link?: Link) => ({ state: s, delivery: { ...delivery, state, reason, link } });
  if (!account) return done('skipped', 'Account not found');
  if (sub.version !== central.strategyVersion) return done('skipped', `Subscription uses strategy v${sub.version}; signal is v${central.strategyVersion}`, { to: '/strategies', label: 'Open subscription' });

  const plan = s.exitPlans.find((p) => p.id === sub.exitPlanId);
  const snapshot = {
    strategyVersion: sub.version,
    subscriptionLabel: sub.label,
    riskPolicy: `${account.name} risk settings`,
    exitPlanLabel: plan ? `${plan.name} v${plan.version}` : 'None attached',
    orderCost: sub.orderCost,
    leverage: sub.leverage
  };
  const withSnap = { ...delivery, snapshot };

  // Existing managed position from this strategy on the same pair.
  const existing = s.positions.find((p) => p.accountId === account.id && p.pair === central.pair && p.managed !== false && p.strategyId === sub.strategyId);
  if (existing) {
    if (existing.direction === direction) {
      return { state: s, delivery: { ...withSnap, state: 'skipped', reason: `Existing ${existing.direction} ${central.pair} position blocks another entry — one position per account and pair`, link: { to: '/positions-orders', label: 'View position' } } };
    }
    const oppositeEnabled = existing.exitRuntime?.config.closeOnOpposite ?? existing.exitSnapshot?.oppositeExit ?? false;
    if (!oppositeEnabled) {
      return {
        state: s,
        delivery: { ...withSnap, kind: 'opposite-close', state: 'skipped', reason: `Existing ${existing.direction} position kept — its saved exit plan does not close on opposite signals. Reverse position is not opened in this demo.`, link: { to: '/positions-orders', label: 'View position' } }
      };
    }
    const block = submissionBlockReason(account);
    if (block) return { state: s, delivery: { ...withSnap, kind: 'opposite-close', state: 'failed', reason: `Opposite-signal close not submitted — ${block}`, link: { to: '/exchange-connections', label: 'Open connection' } } };
    return closeForSignal(s, central, existing, withSnap, 'opposite-close', 'Opposite signal under the saved exit plan · reverse position not opened · ');
  }

  if (s.globalHalt) return { state: s, delivery: { ...withSnap, state: 'skipped', reason: 'Global entry halt active — new entries blocked platform-wide; protective management continues' } };
  if (user?.status === 'suspended') return { state: s, delivery: { ...withSnap, state: 'skipped', reason: 'User suspended — new entries blocked; protective management and closes continue' } };
  if (user?.entriesPaused) return { state: s, delivery: { ...withSnap, state: 'skipped', reason: 'User entries paused by an administrator' } };

  const positions = s.positions.filter((p) => p.accountId === account.id);
  const pending = [...s.pendingEntries.filter((e) => e.accountId === account.id), ...pendingEntriesFromOrders(s.orders, account.id)];
  const ledger = s.closedTrades.filter((t) => t.accountId === account.id);
  const summary = summarizeAccount(account, positions, ledger, s.transfers.filter((t) => t.accountId === account.id), reservedMarginFor(s.orders, account.id));
  const settings = riskSettingsFor(s.riskSettings, account.id);
  const usage = computeRiskUsage(summary, positions, pending, settings);
  const market = s.paperPrices[central.pair] ?? previewMarket[central.pair];
  const deviationPct = Math.round(Math.abs(central.referencePrice - market) / market * 10000) / 100;
  const items = runReadiness({
    subscription: sub,
    strategy: strategyTemplates.find((t) => t.id === sub.strategyId),
    pair: central.pair,
    direction,
    account,
    positions,
    pending,
    trades: ledger.filter((t) => t.kind !== 'entry-fee' && t.kind !== 'partial' && t.kind !== 'funding' && t.kind !== 'correction'),
    settings,
    usage,
    globalPaused: user?.workspacePaused ?? false,
    feeRatePct: s.simFeeRatePct,
    inputs: { signalAgeSec: Math.round((central.receivedAt - central.candleCloseAt) / 1000), spreadPct: SIM_SPREAD_PCT, deviationPct },
    nowSec: timeToSeconds(formatClock(evalAt)),
    timeToSeconds,
    exitPlan: plan,
    atr: s.scenarioOverrides?.atr[central.pair] ?? simulatedAtr[central.pair],
    price: central.referencePrice
  });
  const failing = items.find((x) => x.state === 'fail') ?? items.find((x) => x.state === 'pending');
  if (failing) {
    const o = outcomeForCheck(failing);
    return { state: s, delivery: { ...withSnap, state: o.state, reason: `${failing.label}: ${failing.detail}`, link: o.link } };
  }
  return executeEntry(s, { central, delivery: withSnap, sub, plan: plan!, account, direction });
}

function evaluateClose(s: DemoState, central: CentralSignal, accountId: string, sub: Subscription | null, evalAt: number): {state: DemoState;delivery: Delivery;} {
  const account = s.accounts.find((a) => a.id === accountId);
  const direction: Direction = central.action === 'close-long' ? 'long' : 'short';
  const delivery: Delivery = { id: nextSignalId('DLV', evalAt), userId: ownerOf(account), accountId, subscriptionId: sub?.id ?? null, kind: 'close', state: 'evaluating', reason: '', evaluatedAt: evalAt, orderIds: [] };
  const p = s.positions.find((x) => x.accountId === accountId && x.pair === central.pair && x.direction === direction && x.managed !== false && x.strategyId === central.strategyId);
  const name = strategyTemplates.find((t) => t.id === central.strategyId)?.name ?? central.strategyId;
  if (!p) return { state: s, delivery: { ...delivery, state: 'skipped', reason: `No open ${direction} ${central.pair} position from ${name} on this account — nothing to close` } };
  const block = submissionBlockReason(account);
  if (block) return { state: s, delivery: { ...delivery, state: 'failed', reason: `Close not submitted — ${block}. Existing protection unchanged.`, positionId: p.id, link: { to: '/exchange-connections', label: 'Open connection' } } };
  return closeForSignal(s, central, p, delivery, 'close', 'Close signal · ');
}

/**
 * Receives one signal: validates, stores the receipt (always), and — only when accepted —
 * evaluates every relevant account independently. One failing account never stops the rest.
 */
export function processSignal(state: DemoState, input: SignalInput, at: number, scenario?: string): DemoState {
  const v = validateSignal(input, { routes: state.routes, signals: state.centralSignals, watermarks: state.watermarks, now: at });
  const route = v.route;
  const validatedAt = (Number.isFinite(input.receivedAt) ? input.receivedAt : at) + 35;
  const central: CentralSignal = {
    id: nextSignalId('RCV', at),
    signalId: input.signalId,
    routeId: input.routeId,
    strategyId: route?.strategyId ?? 'unknown',
    strategyVersion: input.strategyVersion,
    sourceExchange: route?.sourceExchange ?? 'unknown',
    sourceSymbol: v.sourceSymbol ?? 'unmapped',
    pair: input.pair,
    action: input.action,
    timeframe: route?.timeframe ?? '—',
    candleCloseAt: input.candleCloseAt,
    createdAt: input.createdAt,
    receivedAt: input.receivedAt,
    validatedAt,
    referencePrice: input.referencePrice,
    confirmed: input.confirmed,
    payload: buildPayload(input, route),
    checks: v.checks,
    outcome: v.outcome,
    reason: v.reason,
    duplicateOf: v.duplicateOf,
    deliveries: [],
    scenario,
    routeLabel: route?.label,
    triggerLabel: route ? routeTriggerName(route) : undefined
  };
  if (v.outcome !== 'accepted' || !route) return { ...state, centralSignals: [central, ...state.centralSignals] };
  // Information-only routes are logged in the feed with no trading actions.
  if (routeUsage(route) === 'info') {
    return { ...state, centralSignals: [{ ...central, infoOnly: true, reason: 'Information only — logged without opening, closing or reversing trades.' }, ...state.centralSignals] };
  }

  const key = watermarkKey(route.strategyId, input.strategyVersion, input.pair);
  const wm = state.watermarks[key];
  let s: DemoState = {
    ...state,
    watermarks: { ...state.watermarks, [key]: wm && wm.candleAt === input.candleCloseAt ? { candleAt: wm.candleAt, actions: [...wm.actions, input.action] } : { candleAt: input.candleCloseAt, actions: [input.action] } }
  };

  const owner = (accountId: string) => ownerOf(s.accounts.find((a) => a.id === accountId));
  const subs = s.subscriptions.
  filter((x) => x.strategyId === route.strategyId && x.lifecycle !== 'archived' && s.accounts.some((a) => a.id === x.accountId)).
  sort((a, b) => owner(a.accountId).localeCompare(owner(b.accountId)) || a.accountId.localeCompare(b.accountId));
  const deliveries: Delivery[] = [];

  if (isEntryAction(input.action)) {
    subs.forEach((sub, i) => {
      const r = evaluateEntry(s, central, sub, validatedAt + 25 + i * 15);
      s = r.state;
      deliveries.push(r.delivery);
    });
  } else {
    const accountIds = [...new Set([...subs.map((x) => x.accountId), ...s.positions.filter((p) => p.strategyId === route.strategyId && p.managed !== false).map((p) => p.accountId)])];
    accountIds.forEach((id, i) => {
      const r = evaluateClose(s, central, id, subs.find((x) => x.accountId === id) ?? null, validatedAt + 25 + i * 15);
      s = r.state;
      deliveries.push(r.delivery);
    });
  }

  const records: SignalRecord[] = deliveries.map((d) => ({
    id: `${central.id}-${d.accountId}`,
    accountId: d.accountId,
    strategyId: central.strategyId,
    pair: central.pair,
    action: ACTION_LABELS[central.action],
    timeframe: central.timeframe,
    candleCloseAt: formatClock(central.candleCloseAt),
    receivedAt: formatClock(central.receivedAt),
    result: resultFor(d.state),
    reason: d.reason,
    centralId: central.id,
    deliveryState: d.state,
    at: central.receivedAt,
    link: d.link
  }));
  const notes = deliveries.
  filter((d) => d.state === 'skipped' || d.state === 'rejected' || d.state === 'failed' || d.state === 'unknown').
  map((d) => makeActivity({ accountId: d.accountId, strategyId: central.strategyId, pair: central.pair }, d.evaluatedAt, d.state === 'skipped' ? 'skip' : 'reject', `Signal ${d.state === 'unknown' ? 'outcome unknown' : d.state}`, d.reason));
  const alerts = deliveries.
  filter((d) => d.state === 'failed' || d.state === 'unknown').
  map((d) => makeNotification(s, d.accountId, d.evaluatedAt, d.state === 'unknown' ? 'Signal outcome unknown' : 'Signal execution failed', `${central.pair} · ${ACTION_LABELS[central.action]} · ${d.reason}`, 'warning'));

  return {
    ...s,
    centralSignals: [{ ...central, deliveries }, ...s.centralSignals],
    signals: [...s.signals, ...records],
    activity: [...notes, ...s.activity],
    notifications: [...alerts, ...s.notifications]
  };
}