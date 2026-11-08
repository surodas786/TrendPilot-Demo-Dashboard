import { connectionHealth, entryState } from './connectionHealth';
import type { RiskBlocker } from './riskEngine';
import { planLabel } from './exitPlanText';
import type { ExitPlan } from '../types/exitPlan';
import type { DirectionScope, Subscription, SubscriptionStatus } from '../types/strategy';
import type { DemoAccount } from '../types/trading';

export const STATUS_META: Record<SubscriptionStatus, {label: string;tone: 'accent' | 'gain' | 'loss' | 'warn' | 'neutral';}> = {
  draft: { label: 'Draft', tone: 'neutral' },
  'setup-incomplete': { label: 'Setup incomplete', tone: 'warn' },
  ready: { label: 'Ready', tone: 'accent' },
  active: { label: 'Active', tone: 'gain' },
  paused: { label: 'Paused', tone: 'warn' },
  blocked: { label: 'Blocked', tone: 'loss' },
  archived: { label: 'Archived', tone: 'neutral' }
};

export const DIRECTION_LABELS: Record<DirectionScope, string> = {
  long: 'Long only',
  short: 'Short only',
  both: 'Long and short'
};

export interface BlockReason {
  id: string;
  text: string;
}

export interface SubscriptionView {
  status: SubscriptionStatus;
  reasons: BlockReason[];
  nextAction: string;
  canPause: boolean;
  canResume: boolean;
  canActivate: boolean;
}

interface Context {
  account: DemoAccount | undefined;
  globalPaused: boolean;
  riskBlockers: RiskBlocker[];
  exitPlan: ExitPlan | undefined;
}

/** Account-level reasons that block new entries (connection, pauses). Excludes subscription and risk reasons. */
export function accountConnectionReasons(account: DemoAccount | undefined): BlockReason[] {
  if (!account) return [{ id: 'account-missing', text: 'Account no longer exists' }];
  if (account.disconnected) return [{ id: 'disconnected', text: `${account.name} is disconnected` }];
  const reasons: BlockReason[] = [];
  if (account.entriesPaused) reasons.push({ id: 'account-paused', text: `New entries paused for ${account.name}` });
  const h = connectionHealth(account);
  if (h.credentials === 'failed') reasons.push({ id: 'credentials', text: 'Connection check failed — demo credentials rejected' });
  if (h.tradePermission === 'failed') reasons.push({ id: 'permission', text: 'Connection check failed — trade permission missing' });
  if (h.publicFeed === 'failed') reasons.push({ id: 'public-feed', text: 'Public market feed unavailable' });
  if (h.privateFeed === 'failed') reasons.push({ id: 'private-feed', text: 'Private account feed unavailable' });
  if (h.sync === 'failed') reasons.push({ id: 'sync', text: 'Account synchronization failed' });
  if (account.needsRevalidation && entryState(account).kind === 'validation') {
    reasons.push({ id: 'revalidate', text: 'Connection validation and sync required' });
  }
  return reasons;
}

export function subscriptionView(sub: Subscription, ctx: Context): SubscriptionView {
  if (sub.lifecycle === 'archived') {
    return { status: 'archived', reasons: [{ id: 'archived', text: 'Archived — no future entries' }], nextAction: 'No action — history preserved', canPause: false, canResume: false, canActivate: false };
  }
  const reasons: BlockReason[] = [];
  const plan = ctx.exitPlan;
  if (sub.lifecycle === 'draft') reasons.push({ id: 'draft', text: 'Draft — subscription setup not saved as complete' });
  if (!sub.exitPlanId) reasons.push({ id: 'exit-plan', text: 'No exit plan attached' });else
  if (!plan) reasons.push({ id: 'exit-plan', text: 'Attached exit plan not found' });else
  if (plan.status === 'archived') reasons.push({ id: 'exit-plan', text: `Attached exit plan ${planLabel(plan)} is archived — attach a valid plan` });else
  if (plan.status === 'draft') reasons.push({ id: 'exit-plan', text: `Attached exit plan ${planLabel(plan)} is a draft` });else
  if (plan.accountId !== sub.accountId) reasons.push({ id: 'exit-plan', text: 'Attached exit plan belongs to another account' });
  const planReady = Boolean(plan && plan.status === 'valid' && plan.accountId === sub.accountId);
  if (sub.paused) reasons.push({ id: 'sub-paused', text: 'Subscription paused' });
  reasons.push(...accountConnectionReasons(ctx.account));
  if (ctx.globalPaused) reasons.push({ id: 'global', text: 'Workspace-wide pause of new entries is active' });
  if (ctx.account) {
    const removed = sub.pairs.filter((p) => !ctx.account!.preferences.allowedPairs.includes(p));
    if (removed.length) reasons.push({ id: 'pairs', text: `${removed.join(', ')} no longer allowed on this account` });
  }
  ctx.riskBlockers.forEach((b) => reasons.push({ id: `risk-${b.id}`, text: b.reason }));

  let status: SubscriptionStatus;
  if (sub.lifecycle === 'draft') status = 'draft';else
  if (!planReady) status = 'setup-incomplete';else
  if (sub.paused) status = 'paused';else
  if (reasons.length > 0) status = 'blocked';else
  status = sub.activated ? 'active' : 'ready';

  const nextAction =
  status === 'draft' ?
  'Complete setup and save the subscription' :
  status === 'setup-incomplete' ?
  'Attach a valid exit plan in Exit Settings' :
  status === 'paused' ?
  'Resume when eligible' :
  status === 'blocked' ?
  `Resolve: ${reasons[0].text}` :
  status === 'ready' ?
  'Activate paper subscription' :
  'Eligible for the next qualifying simulated signal';

  return {
    status,
    reasons,
    nextAction,
    canPause: sub.lifecycle === 'saved' && !sub.paused,
    canResume: sub.lifecycle === 'saved' && sub.paused,
    canActivate: status === 'ready'
  };
}

export function directionsOverlap(a: DirectionScope, b: DirectionScope): boolean {
  return a === 'both' || b === 'both' || a === b;
}

/** Same strategy version, account and pair with overlapping directions is a duplicate. */
export function findConflicts(candidate: Pick<Subscription, 'id' | 'strategyId' | 'version' | 'accountId' | 'pairs' | 'directions'>, all: Subscription[]) {
  return all.
  filter(
    (s) =>
    s.id !== candidate.id &&
    s.lifecycle !== 'archived' &&
    s.strategyId === candidate.strategyId &&
    s.version === candidate.version &&
    s.accountId === candidate.accountId &&
    directionsOverlap(s.directions, candidate.directions)
  ).
  flatMap((s) => s.pairs.filter((p) => candidate.pairs.includes(p)).map((pair) => ({ pair, subscription: s })));
}