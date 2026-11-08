import { ADMIN_OPERATOR, demoUsers, ownerOf, secondUserAccounts, secondUserSubscriptions } from '../../data/demoUsers';
import { ACTION_LABELS, routeTriggerName, routeUsage, seedRoutes, USAGE_LABELS } from '../../data/signalRoutes';
import { signalScenarios } from '../../data/signalScenarios';
import { previewMarket } from '../../data/strategyCatalog';
import { DEFAULT_ACCOUNT_SIM } from '../../data/demoFixtures';
import { formatNumber } from '../../utils/format';
import { replaceAccountData } from '../executionReducer';
import { processSignal } from './dispatchEngine';
import { fillSignalEntryRemainder, reconcileSignalEntry } from './entryExecution';
import { applyPaperPrice } from './exitEngine';
import { advancePresentation, loadPresentation } from './presentation';
import { nextSignalId, patchDelivery } from './signalHelpers';
import type { DemoState } from '../demoReducer';
import type { AdminLogEntry, EntryBehavior, SignalInput, SignalRoute, SignalScenarioId } from '../../types/signals';

export type SignalAction =
{type: 'setTraderUser';userId: string;} |
{type: 'submitSignal';input: SignalInput;at: number;} |
{type: 'fillEntryRemainder';orderId: string;at: number;} |
{type: 'reconcileSignalEntry';orderId: string;at: number;} |
{type: 'setPaperPrice';pair: string;price: number;at: number;} |
{type: 'updateRoute';route: SignalRoute;at: number;} |
{type: 'addRoute';route: SignalRoute;at: number;} |
{type: 'setUserEntriesPaused';userId: string;paused: boolean;at: number;} |
{type: 'setUserSuspended';userId: string;suspended: boolean;at: number;} |
{type: 'setGlobalHalt';on: boolean;at: number;} |
{type: 'setComposerDraft';draft: SignalInput | null;} |
{type: 'loadSignalScenario';id: SignalScenarioId;pre?: SignalInput;prefill: SignalInput;at: number;} |
{type: 'loadPresentation';at: number;activate?: boolean;} |
{type: 'advancePresentation';at: number;expectedStep?: number;};

const SIGNAL_ACTIONS = new Set([
'setTraderUser',
'submitSignal',
'fillEntryRemainder',
'reconcileSignalEntry',
'setPaperPrice',
'updateRoute',
'addRoute',
'setUserEntriesPaused',
'setUserSuspended',
'setGlobalHalt',
'setComposerDraft',
'loadSignalScenario',
'loadPresentation',
'advancePresentation']
);

export function isSignalAction(action: {type: string;}): action is SignalAction {
  return SIGNAL_ACTIONS.has(action.type);
}

function adminLog(state: DemoState, at: number, action: string, target: string, previous: string, next: string): AdminLogEntry[] {
  return [{ id: nextSignalId('adm', at), at, operator: ADMIN_OPERATOR, action, target, previous, next }, ...state.adminLog];
}

function routeChanges(prev: SignalRoute, next: SignalRoute): {previous: string[];next: string[];} {
  const p: string[] = [];
  const n: string[] = [];
  const cmp = (label: string, a: string, b: string) => {
    if (a !== b) {
      p.push(`${label}: ${a}`);
      n.push(`${label}: ${b}`);
    }
  };
  cmp('Label', prev.label, next.label);
  cmp('Alert trigger', routeTriggerName(prev), routeTriggerName(next));
  cmp('Use', USAGE_LABELS[routeUsage(prev)], USAGE_LABELS[routeUsage(next)]);
  cmp('Enabled', String(prev.enabled), String(next.enabled));
  cmp('Version', prev.approvedVersion, next.approvedVersion);
  cmp('Source exchange', prev.sourceExchange, next.sourceExchange);
  cmp('Symbols', JSON.stringify(prev.symbolMap), JSON.stringify(next.symbolMap));
  cmp('Timeframe', prev.timeframe, next.timeframe);
  cmp('Actions', prev.allowedActions.map((a) => ACTION_LABELS[a]).join(', '), next.allowedActions.map((a) => ACTION_LABELS[a]).join(', '));
  cmp('Max entry age', `${prev.maxSignalAgeSec} s`, `${next.maxSignalAgeSec} s`);
  cmp('Max close age', `${prev.closeMaxSignalAgeSec} s`, `${next.closeMaxSignalAgeSec} s`);
  cmp('Confirmation', prev.requireConfirmed ? 'Required' : 'Not required', next.requireConfirmed ? 'Required' : 'Not required');
  cmp('Entry signals', prev.acceptEntries ? 'Accepted' : 'Blocked', next.acceptEntries ? 'Accepted' : 'Blocked');
  cmp('Close signals', prev.acceptCloses ? 'Accepted' : 'Blocked', next.acceptCloses ? 'Accepted' : 'Blocked');
  return { previous: p, next: n };
}

function setupScenario(state: DemoState, id: SignalScenarioId, at: number): DemoState {
  let s = state;
  for (const acct of secondUserAccounts) {
    s = replaceAccountData(s, acct.id, at, { openingEquity: acct.openingEquity, positions: [], orders: [], ledger: [], activity: [], signals: [], sim: DEFAULT_ACCOUNT_SIM }, `Signal scenario — ${id}`);
  }
  const subSeeds = secondUserSubscriptions.map((x) => ({ ...x, pairs: [...x.pairs], paused: id === 'paused-sub' && x.id === 'sub-c-trend', updatedAt: at }));
  s = {
    ...s,
    subscriptions: [...s.subscriptions.filter((x) => !subSeeds.some((y) => y.id === x.id)), ...subSeeds],
    users: s.users.map((u) => u.id === 'user-2' ? { ...demoUsers[1] } : u),
    globalHalt: false,
    routes: seedRoutes.map((r) => ({ ...r, symbolMap: { ...r.symbolMap }, allowedActions: [...r.allowedActions] })),
    watermarks: {},
    paperPrices: { ...previewMarket },
    scenarioOverrides: null,
    presentation: null,
    entryBehavior: id === 'unknown' ? { 'acct-c': 'unknown' } : id === 'partial' ? { 'acct-c': 'partial' } : id === 'protection-fail' ? { 'acct-c': 'protection-fail' } : {}
  };
  if (id === 'two-users') {
    s = replaceAccountData(s, 'acct-a', at, { openingEquity: 5000, positions: [], orders: [], ledger: [], activity: [], signals: [], sim: DEFAULT_ACCOUNT_SIM }, 'Signal-ready fixture SR-A');
    s = {
      ...s,
      accounts: s.accounts.map((a) => a.id === 'acct-a' ? { ...a, entriesPaused: false } : a),
      users: s.users.map((u) => u.id === 'user-1' ? { ...u, status: 'active', entriesPaused: false, workspacePaused: false } : u),
      globalPaused: s.traderUserId === 'user-1' ? false : s.globalPaused,
      subscriptions: s.subscriptions.map((x) => x.id === 'sub-a-trend' ? { ...x, exitPlanId: 'xp-example-v1', activated: true, paused: false, lifecycle: 'saved', updatedAt: at } : x)
    };
  }
  return s;
}

export function signalReducer(state: DemoState, action: SignalAction): DemoState {
  switch (action.type) {
    case 'setTraderUser':{
        const user = state.users.find((u) => u.id === action.userId);
        if (!user) return state;
        const owned = state.accounts.filter((a) => ownerOf(a) === user.id);
        const keep = owned.some((a) => a.id === state.accountId);
        return { ...state, traderUserId: user.id, globalPaused: user.workspacePaused, accountId: keep ? state.accountId : owned[0]?.id ?? state.accountId, selectedPositionId: null, strategyFilter: 'all' };
      }
    case 'submitSignal':
      return processSignal(state, action.input, action.at);
    case 'fillEntryRemainder':
      return fillSignalEntryRemainder(state, action.orderId, action.at);
    case 'reconcileSignalEntry':
      return reconcileSignalEntry(state, action.orderId, action.at);
    case 'setPaperPrice':
      return applyPaperPrice(state, action.pair, action.price, action.at);
    case 'updateRoute':{
        const prev = state.routes.find((r) => r.id === action.route.id);
        if (!prev) return state;
        const c = routeChanges(prev, action.route);
        if (c.next.length === 0) return state;
        return {
          ...state,
          routes: state.routes.map((r) => r.id === prev.id ? { ...action.route, updatedAt: action.at } : r),
          adminLog: adminLog(state, action.at, 'Route policy updated', `${prev.label} (${prev.id})`, c.previous.join(' · '), c.next.join(' · '))
        };
      }
    case 'addRoute':{
        if (state.routes.some((r) => r.id === action.route.id)) return state;
        const r = { ...action.route, updatedAt: action.at };
        return {
          ...state,
          routes: [...state.routes, r],
          adminLog: adminLog(state, action.at, 'Signal route added', `${r.label} (${r.id})`, '—', `${routeTriggerName(r)} · ${r.timeframe} · ${USAGE_LABELS[routeUsage(r)]}`)
        };
      }
    case 'setUserEntriesPaused':{
        const u = state.users.find((x) => x.id === action.userId);
        if (!u || u.entriesPaused === action.paused) return state;
        return {
          ...state,
          users: state.users.map((x) => x.id === u.id ? { ...x, entriesPaused: action.paused } : x),
          adminLog: adminLog(state, action.at, action.paused ? 'User entries paused' : 'User entries resumed', u.name, u.entriesPaused ? 'Paused' : 'Enabled', action.paused ? 'Paused' : 'Enabled')
        };
      }
    case 'setUserSuspended':{
        const u = state.users.find((x) => x.id === action.userId);
        const next = action.suspended ? 'suspended' : 'active';
        if (!u || u.status === next) return state;
        return {
          ...state,
          users: state.users.map((x) => x.id === u.id ? { ...x, status: next } : x),
          adminLog: adminLog(state, action.at, action.suspended ? 'User suspended' : 'User restored', u.name, u.status === 'active' ? 'Active' : 'Suspended', action.suspended ? 'Suspended — new entries blocked, protection and closes continue' : 'Active')
        };
      }
    case 'setGlobalHalt':
      if (state.globalHalt === action.on) return state;
      return {
        ...state,
        globalHalt: action.on,
        adminLog: adminLog(state, action.at, action.on ? 'Global entry halt enabled' : 'Global entry halt released', 'All demo users', action.on ? 'Off' : 'On', action.on ? 'On' : 'Off — narrower user, account and subscription pauses unchanged')
      };
    case 'setComposerDraft':
      return { ...state, composerDraft: action.draft };
    case 'loadPresentation':{
        const s = loadPresentation(state, action.at, action.activate);
        return { ...s, adminLog: adminLog(s, action.at, 'Demo scenario loaded', 'Shared signal to completed trade', '—', 'Presentation Accounts A and B reset · subscriptions Ready · no signal dispatched') };
      }
    case 'advancePresentation':
      return advancePresentation(state, action.at, action.expectedStep);
    case 'loadSignalScenario':{
        const meta = signalScenarios.find((x) => x.id === action.id);
        let s = setupScenario(state, action.id, action.at);
        if (action.pre) s = processSignal(s, action.pre, action.at, meta?.label);
        return {
          ...s,
          composerDraft: action.prefill,
          signalScenario: action.id,
          adminLog: adminLog(s, action.at, 'Demo scenario loaded', meta?.label ?? action.id, '—', `Composer pre-filled${action.pre ? ' · first signal dispatched' : ''}`)
        };
      }
    default:
      return state;
  }
}

/** Keeps a signal delivery's reason in step when its working entry remainder is cancelled. */
export function noteEntryCancelled(state: DemoState, orderId: string): DemoState {
  const o = state.orders.find((x) => x.id === orderId);
  if (!o?.signalContext || o.state !== 'cancelled') return state;
  return patchDelivery(state, o.signalContext.centralId, o.signalContext.deliveryId, {
    reason: `Filled ${formatNumber(o.filledQty, o.quantityDecimals)} ${o.baseAsset}; remainder cancelled with confirmation · reservation released`
  });
}

export type { EntryBehavior };