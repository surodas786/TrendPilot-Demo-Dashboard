import { formatNumber } from '../utils/format';
import { planLabel } from '../utils/exitPlanText';
import type { DemoState } from './demoReducer';
import type { AuditCategory, AuditEntry } from '../types/risk';
import type { ExitPlan } from '../types/exitPlan';
import type { Subscription } from '../types/strategy';

export type ExitPlanSaveKind = 'create' | 'update-draft' | 'new-version' | 'duplicate';

export type StrategyAction =
{type: 'saveSubscription';subscription: Subscription;isNew: boolean;at: number;} |
{type: 'setSubscriptionPaused';id: string;paused: boolean;at: number;} |
{type: 'archiveSubscription';id: string;at: number;} |
{type: 'activateSubscription';id: string;at: number;} |
{type: 'saveExitPlan';plan: ExitPlan;kind: ExitPlanSaveKind;at: number;} |
{type: 'archiveExitPlan';id: string;at: number;} |
{type: 'attachExitPlan';subscriptionId: string;planId: string;at: number;};

const STRATEGY_ACTIONS = new Set<string>([
'saveSubscription',
'setSubscriptionPaused',
'archiveSubscription',
'activateSubscription',
'saveExitPlan',
'archiveExitPlan',
'attachExitPlan']
);

export function isStrategyAction(action: {type: string;}): action is StrategyAction {
  return STRATEGY_ACTIONS.has(action.type);
}

let auditSeq = 0;
export function appendAudit(
state: DemoState,
at: number,
category: AuditCategory,
accountId: string | null,
action: string,
detail: string,
outcome: AuditEntry['outcome'] = 'info',
subscriptionId?: string)
: AuditEntry[] {
  auditSeq += 1;
  return [{ id: `aud-${at}-${auditSeq}`, at, category, accountId, action, detail, outcome, subscriptionId }, ...state.auditLog];
}

function directionText(d: Subscription['directions']): string {
  return d === 'both' ? 'Long and short' : d === 'long' ? 'Long only' : 'Short only';
}

/** Subscriptions that would keep entering with this plan — archiving it is blocked while they exist. */
export function activeUsers(state: Pick<DemoState, 'subscriptions'>, planId: string): Subscription[] {
  return state.subscriptions.filter((s) => s.exitPlanId === planId && s.lifecycle === 'saved' && !s.paused);
}

export function strategyReducer(state: DemoState, action: StrategyAction): DemoState {
  const planName = (id: string | null) => {
    const p = id ? state.exitPlans.find((x) => x.id === id) : undefined;
    return p ? planLabel(p) : 'none';
  };

  switch (action.type) {
    case 'saveSubscription':{
        const sub = action.subscription;
        const prev = state.subscriptions.find((s) => s.id === sub.id);
        const changes: string[] = [];
        if (prev) {
          if (prev.label !== sub.label) changes.push(`Label “${prev.label}” → “${sub.label}”`);
          if (prev.pairs.join() !== sub.pairs.join()) changes.push(`Pairs ${prev.pairs.join(', ')} → ${sub.pairs.join(', ')}`);
          if (prev.directions !== sub.directions) changes.push(`Directions ${directionText(prev.directions)} → ${directionText(sub.directions)}`);
          if (prev.emaFilter !== sub.emaFilter) changes.push(`EMA 200 filter ${sub.emaFilter ? 'enabled' : 'disabled'}`);
          if (prev.orderCost !== sub.orderCost) changes.push(`Order cost ${formatNumber(prev.orderCost)} → ${formatNumber(sub.orderCost)} USDT`);
          if (prev.leverage !== sub.leverage) changes.push(`Leverage ${prev.leverage}× → ${sub.leverage}×`);
          if (prev.exitPlanId !== sub.exitPlanId) changes.push(sub.exitPlanId ? `Exit plan → ${planName(sub.exitPlanId)} (future entries only)` : 'Exit plan detached');
          if (prev.lifecycle !== sub.lifecycle) changes.push(sub.lifecycle === 'saved' ? 'Saved as complete setup' : 'Saved as draft');
        }
        const detail = prev ?
        changes.join(' · ') || 'No field changes' :
        `${sub.pairs.join(', ')} · ${directionText(sub.directions)} · ${formatNumber(sub.orderCost)} USDT × ${sub.leverage}× · ${
        sub.lifecycle === 'draft' ? 'Draft' : sub.exitPlanId ? `Exit plan ${planName(sub.exitPlanId)}` : 'Setup incomplete — exit plan required'}`;

        return {
          ...state,
          subscriptions: prev ? state.subscriptions.map((s) => s.id === sub.id ? sub : s) : [sub, ...state.subscriptions],
          auditLog: appendAudit(state, action.at, 'subscription', sub.accountId, prev ? `Subscription updated — ${sub.label}` : `Subscription created — ${sub.label}`, detail, 'success', sub.id)
        };
      }

    case 'setSubscriptionPaused':{
        const sub = state.subscriptions.find((s) => s.id === action.id);
        if (!sub) return state;
        return {
          ...state,
          subscriptions: state.subscriptions.map((s) => s.id === action.id ? { ...s, paused: action.paused, updatedAt: action.at } : s),
          auditLog: appendAudit(
            state,
            action.at,
            'subscription',
            sub.accountId,
            `${action.paused ? 'New entries paused' : 'New entries resumed'} — ${sub.label}`,
            action.paused ? 'Future entries blocked · existing positions continue under saved exit plans' : 'Subscription pause lifted · account and workspace controls still apply',
            'info',
            sub.id
          )
        };
      }

    case 'archiveSubscription':{
        const sub = state.subscriptions.find((s) => s.id === action.id);
        if (!sub) return state;
        return {
          ...state,
          subscriptions: state.subscriptions.map((s) => s.id === action.id ? { ...s, lifecycle: 'archived', updatedAt: action.at } : s),
          auditLog: appendAudit(state, action.at, 'subscription', sub.accountId, `Subscription archived — ${sub.label}`, 'Future entries blocked · history preserved', 'info', sub.id)
        };
      }

    case 'activateSubscription':{
        const sub = state.subscriptions.find((s) => s.id === action.id);
        if (!sub || sub.activated || sub.lifecycle !== 'saved') return state;
        return {
          ...state,
          subscriptions: state.subscriptions.map((s) => s.id === action.id ? { ...s, activated: true, updatedAt: action.at } : s),
          auditLog: appendAudit(
            state,
            action.at,
            'subscription',
            sub.accountId,
            `Paper subscription activated — ${sub.label}`,
            `Eligible for future simulated signals with ${planName(sub.exitPlanId)} · no order placed · paper setup only, not live-trading readiness`,
            'success',
            sub.id
          )
        };
      }

    case 'saveExitPlan':{
        const plan = action.plan;
        const exists = state.exitPlans.some((p) => p.id === plan.id);
        const verb =
        action.kind === 'new-version' ?
        `Exit plan version created — ${planLabel(plan)}` :
        action.kind === 'duplicate' ?
        `Exit plan duplicated — ${planLabel(plan)}` :
        action.kind === 'update-draft' ?
        `Exit plan updated — ${planLabel(plan)}` :
        `Exit plan created — ${planLabel(plan)}`;
        const detail =
        action.kind === 'new-version' ?
        `Saved as ${plan.status === 'valid' ? 'Valid' : 'Draft'} · earlier versions kept for existing snapshots · linked subscriptions keep their current version until you attach this one` :
        `Saved as ${plan.status === 'valid' ? 'Valid' : 'Draft'}`;
        return {
          ...state,
          exitPlans: exists ? state.exitPlans.map((p) => p.id === plan.id ? plan : p) : [plan, ...state.exitPlans],
          auditLog: appendAudit(state, action.at, 'exit-plan', plan.accountId, verb, detail, 'success')
        };
      }

    case 'archiveExitPlan':{
        const plan = state.exitPlans.find((p) => p.id === action.id);
        if (!plan || plan.status === 'archived' || activeUsers(state, plan.id).length > 0) return state;
        return {
          ...state,
          exitPlans: state.exitPlans.map((p) => p.id === plan.id ? { ...p, status: 'archived', updatedAt: action.at } : p),
          auditLog: appendAudit(state, action.at, 'exit-plan', plan.accountId, `Exit plan archived — ${planLabel(plan)}`, 'Unavailable for new attachments · historical references preserved', 'info')
        };
      }

    case 'attachExitPlan':{
        const plan = state.exitPlans.find((p) => p.id === action.planId);
        const sub = state.subscriptions.find((s) => s.id === action.subscriptionId);
        if (!plan || !sub || plan.status !== 'valid' || plan.accountId !== sub.accountId || sub.lifecycle === 'archived') return state;
        if (sub.exitPlanId === plan.id) return state;
        const previous = sub.exitPlanId ? planName(sub.exitPlanId) : null;
        const detail = `${previous ? `Replaced ${previous} · ` : ''}Applies to future entries only · existing positions keep their original exit snapshot and trailing state`;
        let log = appendAudit(state, action.at, 'subscription', sub.accountId, `Exit plan attached — ${sub.label}`, `${planLabel(plan)} · ${detail}`, 'success', sub.id);
        log = appendAudit({ ...state, auditLog: log }, action.at, 'exit-plan', plan.accountId, `Attached to subscription — ${planLabel(plan)}`, sub.label, 'success');
        return {
          ...state,
          subscriptions: state.subscriptions.map((s) => s.id === sub.id ? { ...s, exitPlanId: plan.id, updatedAt: action.at } : s),
          auditLog: log
        };
      }

    default:
      return state;
  }
}