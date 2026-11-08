import { PLATFORM_LIMITS, previewMarket } from '../data/strategyCatalog';
import { connectionHealth } from './connectionHealth';
import { computeOrderPreview } from './riskEngine';
import type { RiskUsage } from './riskEngine';
import { formatNumber } from './format';
import type { PendingEntry, ReadinessDemoInputs, ReadinessItem, RiskSettings } from '../types/risk';
import { computeExitPreview } from './exitPlanMath';
import { planLabel } from './exitPlanText';
import type { ExitPlan } from '../types/exitPlan';
import type { StrategyTemplate, Subscription } from '../types/strategy';
import type { ClosedTrade, DemoAccount, Direction, Position } from '../types/trading';

export interface ReadinessInput {
  subscription: Subscription;
  strategy: StrategyTemplate | undefined;
  pair: string;
  direction: Direction;
  account: DemoAccount | undefined;
  positions: Position[];
  pending: PendingEntry[];
  trades: ClosedTrade[];
  settings: RiskSettings;
  usage: RiskUsage;
  globalPaused: boolean;
  feeRatePct: number;
  inputs: ReadinessDemoInputs;
  /** Seconds since midnight, Asia/Dhaka. */
  nowSec: number;
  timeToSeconds: (t: string) => number;
  exitPlan: ExitPlan | undefined;
  /** Simulated ATR for the pair (preview data, not market data). */
  atr: number;
  /** Reference price override (signal reference price). Defaults to the preview market price. */
  price?: number;
}

const pass = (id: string, label: string, detail: string): ReadinessItem => ({ id, label, state: 'pass', detail });
const fail = (id: string, label: string, detail: string): ReadinessItem => ({ id, label, state: 'fail', detail });
const pend = (id: string, label: string, detail: string): ReadinessItem => ({ id, label, state: 'pending', detail });

/** Dry run only. Never places or reserves anything. */
export function runReadiness(i: ReadinessInput): ReadinessItem[] {
  const { subscription: sub, account, settings, usage } = i;
  const items: ReadinessItem[] = [];
  const dirLabel = i.direction === 'long' ? 'Long' : 'Short';
  const plan = i.exitPlan;
  const planUsable = Boolean(plan && plan.status === 'valid' && plan.accountId === sub.accountId);
  const refPrice = i.price ?? previewMarket[i.pair];
  const exitPreview =
  plan && planUsable ?
  computeExitPreview({
    config: plan.config,
    pair: i.pair,
    direction: i.direction,
    entryPrice: refPrice,
    atr: i.atr,
    orderCost: sub.orderCost,
    leverage: sub.leverage,
    feeRatePct: i.feeRatePct
  }) :
  null;

  // 1. Strategy and subscription status
  {
    const label = 'Strategy and subscription status';
    if (!i.strategy || i.strategy.version !== sub.version) items.push(fail('status', label, 'Strategy version is not approved'));else
    if (sub.lifecycle === 'archived') items.push(fail('status', label, 'Subscription is archived'));else
    if (sub.lifecycle === 'draft') items.push(fail('status', label, 'Subscription is a draft — a draft cannot trade'));else
    if (!planUsable) items.push(fail('status', label, 'Setup incomplete — no valid exit plan attached'));else
    if (sub.paused) items.push(fail('status', label, 'Subscription paused'));else
    if (!sub.activated) items.push(pend('status', label, 'Ready but not activated — activate the paper subscription to accept future simulated signals'));else
    items.push(pass('status', label, `${i.strategy.name} v${sub.version} approved · paper subscription active`));
  }

  // 2. Connection and permissions
  {
    const label = 'Account connection and permissions';
    const h = account ? connectionHealth(account) : null;
    if (!account) items.push(fail('connection', label, 'Account not found'));else
    if (account.disconnected) items.push(fail('connection', label, `${account.name} is disconnected`));else
    if (h!.credentials === 'failed') items.push(fail('connection', label, 'Demo credentials rejected'));else
    if (h!.tradePermission === 'failed') items.push(fail('connection', label, 'Trade permission missing'));else
    if (account.needsRevalidation) items.push(fail('connection', label, 'Validation and synchronization required'));else
    items.push(pass('connection', label, 'Credentials valid · trade permission granted (simulated)'));
  }

  // 3. Pauses
  {
    const label = 'Account and broader entry pauses';
    const reasons: string[] = [];
    if (account?.entriesPaused) reasons.push('account new entries paused');
    if (i.globalPaused) reasons.push('workspace-wide pause active');
    if (reasons.length) items.push(fail('pauses', label, capitalize(reasons.join(' · '))));else
    items.push(pass('pauses', label, 'No account or workspace pause'));
  }

  // 4. Pair and direction eligibility
  {
    const label = 'Pair and direction eligibility';
    if (!sub.pairs.includes(i.pair)) items.push(fail('pair', label, `${i.pair} is not part of this subscription`));else
    if (account && !account.preferences.allowedPairs.includes(i.pair)) items.push(fail('pair', label, `${i.pair} is not allowed on ${account.name}`));else
    if (sub.directions !== 'both' && sub.directions !== i.direction) items.push(fail('pair', label, `${dirLabel} is not permitted by this subscription`));else
    items.push(pass('pair', label, `${i.pair} ${dirLabel} permitted`));
  }

  // 5. Position / pending conflict
  {
    const label = 'Existing position or pending-entry conflict';
    const pos = i.positions.find((p) => p.pair === i.pair);
    const pendingSame = i.pending.find((e) => e.pair === i.pair);
    if (pos) {
      const opposite = pos.direction !== i.direction;
      items.push(
        fail(
          'conflict',
          label,
          `${i.pair} ${pos.direction === 'long' ? 'long' : 'short'} position already open${opposite ? ' — opposite exposure is disabled' : ''}. One position or pending entry per account and pair.`
        )
      );
    } else if (pendingSame) items.push(fail('conflict', label, `A pending ${i.pair} entry already exists`));else
    items.push(pass('conflict', label, `No open position or pending entry for ${i.pair}`));
  }

  // 6. Data health
  {
    const label = 'Market and account data health';
    if (!account || account.disconnected) items.push(fail('data', label, 'No data while disconnected'));else
    {
      const h = connectionHealth(account);
      const bad = [
      h.publicFeed === 'failed' && 'public market feed unavailable',
      h.privateFeed === 'failed' && 'private account feed unavailable',
      h.sync === 'failed' && 'account synchronization failed'].
      filter(Boolean) as string[];
      if (bad.length) items.push(fail('data', label, capitalize(bad.join(' · '))));else
      items.push(pass('data', label, 'Public feed, private feed and sync healthy (simulated)'));
    }
  }

  // 7. Signal freshness
  {
    const label = 'Signal freshness';
    const limit = Math.min(settings.maxSignalAgeSec, i.strategy?.maxSignalAgeSec ?? settings.maxSignalAgeSec);
    const source = i.strategy && i.strategy.maxSignalAgeSec < settings.maxSignalAgeSec ? 'strategy limit' : 'account limit';
    if (i.inputs.signalAgeSec > limit) items.push(fail('freshness', label, `Signal age ${i.inputs.signalAgeSec} s exceeds ${limit} s (${source})`));else
    items.push(pass('freshness', label, `Signal age ${i.inputs.signalAgeSec} s within ${limit} s (${source})`));
  }

  // 8. Spread
  if (i.inputs.spreadPct > settings.maxSpreadPct) {
    items.push(fail('spread', 'Spread', `Spread ${i.inputs.spreadPct}% exceeds maximum ${settings.maxSpreadPct}%`));
  } else items.push(pass('spread', 'Spread', `Spread ${i.inputs.spreadPct}% within ${settings.maxSpreadPct}%`));

  // 9. Deviation
  if (i.inputs.deviationPct > settings.maxDeviationPct) {
    items.push(fail('deviation', 'Entry deviation', `Deviation ${i.inputs.deviationPct}% from signal reference exceeds ${settings.maxDeviationPct}%`));
  } else items.push(pass('deviation', 'Entry deviation', `Deviation ${i.inputs.deviationPct}% within ${settings.maxDeviationPct}%`));

  const preview = computeOrderPreview({
    pair: i.pair,
    direction: i.direction,
    orderCost: sub.orderCost,
    leverage: sub.leverage,
    feeRatePct: i.feeRatePct,
    price: refPrice,
    availableMargin: usage.margin.available,
    pendingMargin: usage.margin.pendingMargin,
    reserve: settings.freeMarginReserve
  });

  // 10. Margin and reserve
  if (preview.remainingAfter < settings.freeMarginReserve) {
    items.push(fail('margin', 'Margin and reserve', `Remaining margin ${formatNumber(preview.remainingAfter)} USDT would fall below the ${formatNumber(settings.freeMarginReserve)} USDT reserve`));
  } else {
    items.push(pass('margin', 'Margin and reserve', `Requires ${formatNumber(preview.required)} USDT incl. fee · ${formatNumber(preview.remainingAfter)} USDT remains`));
  }

  // 11. Order size and leverage
  {
    const label = 'Order size and leverage';
    if (sub.orderCost > settings.maxOrderCost) items.push(fail('size', label, `Order cost ${formatNumber(sub.orderCost)} exceeds account maximum ${formatNumber(settings.maxOrderCost)} USDT`));else
    if (sub.orderCost > PLATFORM_LIMITS.maxOrderCost) items.push(fail('size', label, `Order cost exceeds platform cap ${formatNumber(PLATFORM_LIMITS.maxOrderCost)} USDT`));else
    if (sub.leverage > PLATFORM_LIMITS.maxLeverage) items.push(fail('size', label, `Leverage exceeds platform cap ${PLATFORM_LIMITS.maxLeverage}×`));else
    if (preview.roundedQuantity < preview.spec.minQuantity) items.push(fail('size', label, `Quantity below simulated minimum ${preview.spec.minQuantity} ${preview.spec.baseAsset}`));else
    items.push(pass('size', label, `${formatNumber(sub.orderCost)} USDT × ${sub.leverage}× → ${formatNumber(preview.resultNotional)} USDT notional`));
  }

  // 12. Position count
  {
    const total = usage.openPositions.used + usage.openPositions.pending + 1;
    if (total > settings.maxOpenPositions) items.push(fail('count', 'Position count', `Entry would make ${total} positions (maximum ${settings.maxOpenPositions})`));else
    items.push(pass('count', 'Position count', `${total} of ${settings.maxOpenPositions} after entry`));
  }

  // 13. Aggregate notional
  {
    const total = usage.notional.used + usage.notional.pending + preview.resultNotional;
    if (total > settings.maxAggregateNotional) items.push(fail('notional', 'Aggregate notional', `${formatNumber(total)} USDT after entry exceeds ${formatNumber(settings.maxAggregateNotional)} USDT`));else
    items.push(pass('notional', 'Aggregate notional', `${formatNumber(total)} of ${formatNumber(settings.maxAggregateNotional)} USDT after entry`));
  }

  // 14. Aggregate initial stop risk, including the proposed entry — unknown risk is never zero.
  {
    const label = 'Aggregate initial stop risk';
    const existing = usage.stopRisk.used + usage.stopRisk.pending;
    if (usage.stopRisk.incomplete) {
      items.push(fail('stop-risk', label, `Risk data incomplete — initial stop unknown for ${usage.stopRisk.unknownPairs.join(', ') || 'a pending entry'}`));
    } else if (!exitPreview) {
      items.push(pend('stop-risk', label, 'Initial stop required to calculate stop risk — pending exit configuration'));
    } else if (exitPreview.grossLossToStop === null) {
      items.push(fail('stop-risk', label, `Proposed entry risk unknown — ${exitPreview.errors[0] ?? 'initial stop could not be calculated'}`));
    } else {
      const total = existing + exitPreview.grossLossToStop;
      const text = `${formatNumber(existing)} existing + ${formatNumber(exitPreview.grossLossToStop)} proposed = ${formatNumber(total)} of ${formatNumber(settings.maxAggregateStopRisk)} USDT`;
      if (total > settings.maxAggregateStopRisk) items.push(fail('stop-risk', label, `${text} — exceeds the limit`));else
      items.push(pass('stop-risk', label, text));
    }
  }

  // 15. Daily loss
  if (usage.dailyLoss.used >= settings.dailyLossLimit) {
    items.push(fail('daily-loss', 'Daily loss', `Daily loss limit reached — ${formatNumber(usage.dailyLoss.used)} of ${formatNumber(settings.dailyLossLimit)} USDT`));
  } else {
    items.push(pass('daily-loss', 'Daily loss', `${formatNumber(usage.dailyLoss.used)} of ${formatNumber(settings.dailyLossLimit)} USDT used (Asia/Dhaka day)`));
  }

  // 16. Cooldown
  {
    const label = 'Cooldown';
    const last = [...i.trades].sort((a, b) => i.timeToSeconds(b.closedAt) - i.timeToSeconds(a.closedAt))[0];
    if (settings.cooldownMinutes === 0) items.push(pass('cooldown', label, 'No cooldown configured'));else
    if (!last) items.push(pass('cooldown', label, 'No completed trade today'));else
    {
      const elapsedMin = (i.nowSec - i.timeToSeconds(last.closedAt)) / 60;
      if (elapsedMin < settings.cooldownMinutes) {
        items.push(fail('cooldown', label, `${Math.ceil(settings.cooldownMinutes - elapsedMin)} min of ${settings.cooldownMinutes} min cooldown remaining after ${last.pair} trade at ${last.closedAt}`));
      } else items.push(pass('cooldown', label, `${Math.floor(elapsedMin)} min since last completed trade`));
    }
  }

  // 17. Exit plan — structural validity plus order-specific checks for this pair and direction.
  {
    const label = 'Exit-plan readiness';
    if (!sub.exitPlanId) items.push(fail('exit-plan', label, 'No exit plan attached — configure in Exit Settings'));else
    if (!plan) items.push(fail('exit-plan', label, 'Attached exit plan not found'));else
    if (!planUsable) items.push(fail('exit-plan', label, `${planLabel(plan)} is ${plan.status === 'archived' ? 'archived' : 'a draft'} — attach a valid plan`));else
    if (exitPreview && exitPreview.errors.length) items.push(fail('exit-plan', label, `${planLabel(plan)}: ${exitPreview.errors[0]}`));else
    if (exitPreview && exitPreview.stopPrice !== null) {
      const dec = exitPreview.spec.priceDecimals;
      items.push(
        pass(
          'exit-plan',
          label,
          `${planLabel(plan)} · initial stop ${formatNumber(exitPreview.stopPrice, dec)} at simulated entry ${formatNumber(refPrice, dec)} · liquidation buffer not checked (unavailable in this simulation)`
        )
      );
    } else items.push(fail('exit-plan', label, 'Initial stop could not be calculated'));
  }

  return items;
}

export function readinessOutcome(items: ReadinessItem[]): 'ready' | 'not-ready' | 'pending' {
  if (items.some((x) => x.state === 'fail')) return 'not-ready';
  if (items.some((x) => x.state === 'pending')) return 'pending';
  return 'ready';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}