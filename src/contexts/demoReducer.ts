import { alignPricesToPositions } from '../utils/priceAlignment';
import {
  accounts as seedAccounts,
  activityEvents,
  closedTrades as seedTrades,
  connectionEvents as seedEvents,
  exchanges,
  notifications as seedNotifications,
  positions as seedPositions,
  REPORTING_DATE,
  signals as seedSignals,
  transfers as seedTransfers } from
'../data/mockData';
import { DEFAULT_RISK_SETTINGS, DEFAULT_SIM_FEE_RATE_PCT, seedPendingEntries, seedSubscriptions } from '../data/strategyCatalog';
import { seedExitPlans } from '../data/exitPlans';
import { seedOrders } from '../data/seedOrders';
import { appendAudit, isStrategyAction, strategyReducer } from './strategyReducer';
import type { StrategyAction } from './strategyReducer';
import { executionReducer, isExecutionAction } from './executionReducer';
import type { ExecutionAction } from './executionReducer';
import { isSignalAction, noteEntryCancelled, signalReducer } from './signals/signalReducer';
import type { SignalAction } from './signals/signalReducer';
import { reconcileSignalEntry } from './signals/entryExecution';
import { applyFinanceSync, financeReducer, initialFinanceState, isFinanceAction, snapshot } from './financeReducer';
import type { FinanceAction, FinanceState } from './financeReducer';
import type { PresentationState, ScenarioOverrides } from '../data/presentation';
import { isUserAction, userReducer } from './userReducer';
import { isTokenAction, tokenReducer } from './signals/tokenExecution';
import type { TokenAction } from './signals/tokenExecution';
import type { PricePoint, SignalProcessing } from '../types/holdings';
import type { UserAction } from './userReducer';
import type { UserLink } from '../types/users';
import { seedUserLinks } from '../data/demoUsers';
import { demoUsers, PRIMARY_USER_ID, secondUserAccounts, secondUserExitPlans, secondUserSubscriptions } from '../data/demoUsers';
import { seedRoutes } from '../data/signalRoutes';
import { previewMarket } from '../data/strategyCatalog';
import type { Watermarks } from '../utils/signalValidation';
import type { AdminLogEntry, CentralSignal, DemoUser, EntryBehavior, SignalInput, SignalRoute, SignalScenarioId } from '../types/signals';
import type { AccountSim, CloseRequest, OrderRecord, TradeRecord } from '../types/execution';
import type { AuditEntry, PendingEntry, RiskSettings } from '../types/risk';
import type { ExitPlan } from '../types/exitPlan';
import type { Subscription } from '../types/strategy';
import { demoStartTime, formatClock } from '../utils/clock';
import { isCredentialScenario, scenarioLabel, syncOutcome } from '../utils/connectionHealth';
import { formatNumber } from '../utils/format';
import type {
  ActivityEvent,
  ClosedTrade,
  ConnectionEvent,
  ConnectionScenario,
  DemoAccount,
  EventOutcome,
  NotificationItem,
  PaperTransfer,
  Position,
  PreviewRole,
  SignalRecord } from
'../types/trading';

export interface DemoState extends FinanceState {
  role: PreviewRole;
  exchangeId: string;
  accountId: string;
  strategyFilter: string;
  reportingDate: string;
  accounts: DemoAccount[];
  positions: Position[];
  /** Every simulated order record (entry, protective and manual close), including completed ones. */
  orders: OrderRecord[];
  /** Realized ledger: opening summaries, partial and final closing fills, recorded entry fees. */
  closedTrades: ClosedTrade[];
  /** One record per fully closed position lifecycle. */
  tradeRecords: TradeRecord[];
  closeRequests: CloseRequest[];
  /** Deterministic simulation behaviour per account (demo fixtures). */
  accountSim: Record<string, AccountSim>;
  transfers: PaperTransfer[];
  activity: ActivityEvent[];
  signals: SignalRecord[];
  notifications: NotificationItem[];
  connectionEvents: ConnectionEvent[];
  lastRefreshAt: number;
  selectedPositionId: string | null;
  /** Workspace-wide pause from the dashboard. Stored separately from account-level pauses. */
  globalPaused: boolean;
  subscriptions: Subscription[];
  /** Account-specific risk policies, keyed by account id. */
  riskSettings: Record<string, RiskSettings>;
  pendingEntries: PendingEntry[];
  auditLog: AuditEntry[];
  /** Simulation assumption for estimated entry fees (percent of notional). */
  simFeeRatePct: number;
  /** All exit-plan versions. Older versions are kept for existing trade snapshots. */
  exitPlans: ExitPlan[];
  /** Fictional demo users; trader screens show only the selected user's records. */
  users: DemoUser[];
  traderUserId: string;
  /** Administrator global entry halt. Narrower pauses are stored separately and never cleared by it. */
  globalHalt: boolean;
  routes: SignalRoute[];
  /** Every central signal receipt attempt, newest first. */
  centralSignals: CentralSignal[];
  watermarks: Watermarks;
  /** Deterministic entry outcome per account (scenarios). Missing = fill. */
  entryBehavior: Record<string, EntryBehavior>;
  /** Shared paper prices for signal-created positions and composer defaults. */
  paperPrices: Record<string, number>;
  adminLog: AdminLogEntry[];
  composerDraft: SignalInput | null;
  signalScenario: SignalScenarioId | null;
  /** Named-demonstration assumptions (e.g. fixed ATR, zero slippage). null = normal simulation rules. */
  scenarioOverrides: ScenarioOverrides | null;
  /** "Shared signal to completed trade" presentation state. null = not loaded. */
  presentation: PresentationState | null;
  /** Simulated invitation and password-reset links. */
  userLinks: UserLink[];
  /** One record per common signal evaluated against token blocks — never repeated. */
  tokenProcessing: SignalProcessing[];
  /** Fully closed token-block positions (final snapshot) for Holdings → Closed Trades. */
  tokenArchive: Position[];
  /** Last update time and recorded history for the single shared price per pair. */
  priceTimes: Record<string, number>;
  priceHistory: Record<string, PricePoint[]>;
}

export type ValidationPurpose = 'test' | 'resume' | 'reconnect';

export interface ConnectionUpdate {
  accountId: string;
  name: string;
  allowedPairs: string[];
  leverage: number;
  isDefault: boolean;
}

export type DemoAction =
{type: 'setRole';role: PreviewRole;} |
{type: 'setExchange';exchangeId: string;} |
{type: 'setAccount';accountId: string;} |
{type: 'setStrategyFilter';strategyId: string;} |
{type: 'setReportingDate';date: string;} |
{type: 'refresh';at: number;} |
{type: 'selectPosition';positionId: string | null;} |
{type: 'toggleGlobalPause';} |
StrategyAction |
{type: 'updateRiskSettings';accountId: string;settings: RiskSettings;changes: string[];exceeded: string[];at: number;} |
{type: 'recordAudit';entry: Omit<AuditEntry, 'id' | 'at'>;at: number;} |
{type: 'setSimFeeRate';pct: number;} |
ExecutionAction |
SignalAction |
FinanceAction |
UserAction |
{type: 'runFinanceSync';accountId: string;at: number;} |
{type: 'markNotificationsRead';} |
{type: 'addConnection';account: DemoAccount;at: number;} |
{type: 'updateConnection';update: ConnectionUpdate;at: number;} |
{type: 'replaceCredentials';accountId: string;ok: boolean;maskedKey?: string;reason?: string;at: number;} |
{type: 'recordValidation';accountId: string;ok: boolean;reason?: string;failedCheckId?: string;purpose: ValidationPurpose;at: number;} |
{type: 'syncAccount';accountId: string;at: number;} |
{type: 'pauseEntries';accountId: string;at: number;} |
{type: 'setScenario';accountId: string;scenario: ConnectionScenario;at: number;} |
{type: 'disconnect';accountId: string;at: number;} |
{type: 'addFunds';accountId: string;amount: number;at: number;} |
TokenAction |
{type: 'reset';};

export function createInitialState(role: PreviewRole = 'trader'): DemoState {
  return {
    ...initialFinanceState([...seedAccounts, ...secondUserAccounts]),
    role,
    exchangeId: exchanges[0].id,
    accountId: seedAccounts[0].id,
    strategyFilter: 'all',
    reportingDate: REPORTING_DATE,
    accounts: [...seedAccounts, ...secondUserAccounts].map((a) => ({ ...a, preferences: { ...a.preferences, allowedPairs: [...a.preferences.allowedPairs] } })),
    positions: seedPositions.map((p) => ({ ...p })),
    orders: seedOrders.map((o) => ({ ...o, fills: o.fills.map((f) => ({ ...f })) })),
    closedTrades: seedTrades.map((t) => ({ ...t })),
    tradeRecords: [],
    closeRequests: [],
    accountSim: {},
    transfers: seedTransfers.map((t) => ({ ...t })),
    activity: activityEvents.map((e) => ({ ...e })),
    signals: seedSignals.map((s) => ({ ...s })),
    notifications: seedNotifications.map((n) => ({ ...n })),
    connectionEvents: seedEvents.map((e) => ({ ...e })),
    lastRefreshAt: demoStartTime(),
    selectedPositionId: null,
    globalPaused: false,
    subscriptions: [...seedSubscriptions, ...secondUserSubscriptions].map((s) => ({ ...s, pairs: [...s.pairs] })),
    exitPlans: [...seedExitPlans, ...secondUserExitPlans].map((p) => ({ ...p, config: { ...p.config } })),
    riskSettings: Object.fromEntries([...seedAccounts, ...secondUserAccounts].map((a) => [a.id, { ...DEFAULT_RISK_SETTINGS }])),
    pendingEntries: seedPendingEntries.map((e) => ({ ...e })),
    auditLog: [],
    simFeeRatePct: DEFAULT_SIM_FEE_RATE_PCT,
    users: demoUsers.map((u) => ({ ...u })),
    traderUserId: PRIMARY_USER_ID,
    globalHalt: false,
    routes: seedRoutes.map((r) => ({ ...r, symbolMap: { ...r.symbolMap }, allowedActions: [...r.allowedActions] })),
    centralSignals: [],
    watermarks: {},
    entryBehavior: {},
    paperPrices: { ...previewMarket },
    adminLog: [],
    composerDraft: null,
    signalScenario: null,
    scenarioOverrides: null,
    presentation: null,
    userLinks: seedUserLinks.map((l) => ({ ...l })),
    tokenProcessing: [],
    tokenArchive: [],
    priceTimes: {},
    priceHistory: {}
  };
}

const audit = appendAudit;

let eventSeq = 0;
function makeEvent(accountId: string, at: number, action: string, outcome: EventOutcome, detail: string): ConnectionEvent {
  eventSeq += 1;
  return { id: `evt-${at}-${eventSeq}`, accountId, at, action, outcome, detail };
}

function patchAccount(state: DemoState, accountId: string, patch: (a: DemoAccount) => DemoAccount): DemoAccount[] {
  return state.accounts.map((a) => a.id === accountId ? patch(a) : a);
}

function withEvents(state: DemoState, events: ConnectionEvent[]): ConnectionEvent[] {
  return [...[...events].reverse(), ...state.connectionEvents];
}

function applySync(state: DemoState, accountId: string, at: number): DemoState {
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) return state;
  if (account.disconnected) {
    return {
      ...state,
      connectionEvents: withEvents(state, [makeEvent(accountId, at, 'Synchronization skipped', 'info', 'Connection is disconnected')])
    };
  }
  const result = syncOutcome(account);
  const openCount = state.positions.filter((p) => p.accountId === accountId).length;
  return {
    ...state,
    accounts: patchAccount(state, accountId, (a) =>
    result.ok ?
    { ...a, lastSyncAt: at, lastSyncAttempt: { at, ok: true } } :
    { ...a, lastSyncAttempt: { at, ok: false, reason: result.reason } }
    ),
    connectionEvents: withEvents(state, [
    makeEvent(
      accountId,
      at,
      result.ok ? 'Synchronization completed' : 'Synchronization failed',
      result.ok ? 'success' : 'failure',
      result.ok ? `Balances and ${openCount} open position${openCount === 1 ? '' : 's'} reconciled` : `${result.reason}. Last successful sync kept.`
    )]
    )
  };
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  if (isTokenAction(action)) return tokenReducer(state, action);
  if (isStrategyAction(action)) return strategyReducer(state, action);
  if (isSignalAction(action)) return signalReducer(state, action);
  if (isFinanceAction(action)) return financeReducer(state, action);
  if (isUserAction(action)) return userReducer(state, action);
  if (action.type === 'runFinanceSync') {
    const synced = applySync(state, action.accountId, action.at);
    const acct = synced.accounts.find((a) => a.id === action.accountId);
    if (!acct || acct.disconnected) return applyFinanceSync(synced, action.accountId, action.at, false, 'Connection is disconnected');
    const attempt = acct.lastSyncAttempt;
    return applyFinanceSync(synced, action.accountId, action.at, Boolean(attempt?.ok && attempt.at === action.at), attempt?.reason);
  }
  if (action.type === 'reconcileOrder') {
    const o = state.orders.find((x) => x.id === action.orderId);
    // Signal entries reconcile through the signal flow so the delivery, position and protection stay linked.
    if (o?.purpose === 'entry' && o.signalContext) return reconcileSignalEntry(state, action.orderId, action.at);
  }
  if (action.type === 'cancelEntryOrder') return noteEntryCancelled(executionReducer(state, action), action.orderId);
  if (isExecutionAction(action)) return executionReducer(state, action);
  switch (action.type) {
    case 'setRole':
      return { ...state, role: action.role };
    case 'setExchange':
      return { ...state, exchangeId: action.exchangeId };
    case 'setAccount':
      return { ...state, accountId: action.accountId };
    case 'setStrategyFilter':
      return { ...state, strategyFilter: action.strategyId };
    case 'setReportingDate':
      return { ...state, reportingDate: action.date };
    case 'refresh':
      return applySync({ ...state, lastRefreshAt: action.at }, state.accountId, action.at);
    case 'selectPosition':
      return { ...state, selectedPositionId: action.positionId };
    case 'toggleGlobalPause':{
        // The trader's workspace pause is stored per demo user.
        const next = !state.globalPaused;
        return { ...state, globalPaused: next, users: state.users.map((u) => u.id === state.traderUserId ? { ...u, workspacePaused: next } : u) };
      }

    case 'updateRiskSettings':{
        const name = state.accounts.find((a) => a.id === action.accountId)?.name ?? '';
        let log = audit(state, action.at, 'settings', action.accountId, `Risk settings saved — ${name}`, action.changes.join(' · ') || 'No changes', 'success');
        if (action.exceeded.length) {
          log = audit({ ...state, auditLog: log }, action.at, 'settings', action.accountId, 'Current exposure exceeds the new limit', `${action.exceeded.join(' · ')} — new entries blocked until exposure is within limits`, 'failure');
        }
        return { ...state, riskSettings: { ...state.riskSettings, [action.accountId]: action.settings }, auditLog: log };
      }

    case 'recordAudit':
      return {
        ...state,
        auditLog: audit(state, action.at, action.entry.category, action.entry.accountId, action.entry.action, action.entry.detail, action.entry.outcome, action.entry.subscriptionId)
      };

    case 'setSimFeeRate':
      return { ...state, simFeeRatePct: action.pct };
    case 'syncAccount':
      return applySync(state, action.accountId, action.at);

    case 'markNotificationsRead':
      return { ...state, notifications: state.notifications.map((n) => (n.userId ?? PRIMARY_USER_ID) === state.traderUserId ? { ...n, read: true } : n) };

    case 'addConnection':{
        const acc = { ...action.account, userId: state.traderUserId };
        const base = acc.preferences.isDefault ?
        state.accounts.map((a) => (a.userId ?? PRIMARY_USER_ID) === state.traderUserId ? { ...a, preferences: { ...a.preferences, isDefault: false } } : a) :
        state.accounts;
        const exchange = exchanges.find((e) => e.id === acc.exchangeId)?.name ?? acc.exchangeId;
        return {
          ...state,
          accounts: [...base, acc],
          riskSettings: { ...state.riskSettings, [acc.id]: { ...DEFAULT_RISK_SETTINGS, defaultLeverage: Math.min(acc.preferences.leverage, DEFAULT_RISK_SETTINGS.defaultLeverage) } },
          connectionEvents: withEvents(state, [
          makeEvent(acc.id, action.at, 'Account created', 'success', `${exchange} · ${acc.environment === 'live' ? 'Live — simulated' : 'Paper simulation'} · ${acc.maskedKey}`),
          makeEvent(acc.id, action.at, 'Validation completed', 'success', '7 of 7 simulated checks passed'),
          makeEvent(acc.id, action.at, 'Synchronization completed', 'success', `Opening virtual balance ${formatNumber(acc.openingEquity)} USDT, no open positions`)]
          ),
          notifications: [
          { id: `ntf-conn-${acc.id}`, title: acc.environment === 'live' ? 'Live — simulated account created' : 'Paper account created', detail: `${acc.name} · opening balance ${formatNumber(acc.openingEquity)} USDT`, time: formatClock(action.at), read: false, tone: 'success', userId: state.traderUserId },
          ...state.notifications]

        };
      }

    case 'updateConnection':{
        const { update } = action;
        const current = state.accounts.find((a) => a.id === update.accountId);
        if (!current) return state;
        const changes: string[] = [];
        if (current.name !== update.name) changes.push(`Label “${current.name}” → “${update.name}”`);
        const added = update.allowedPairs.filter((p) => !current.preferences.allowedPairs.includes(p));
        const removed = current.preferences.allowedPairs.filter((p) => !update.allowedPairs.includes(p));
        if (added.length) changes.push(`Allowed ${added.join(', ')}`);
        if (removed.length) changes.push(`Removed ${removed.join(', ')} for new entries`);
        if (current.preferences.leverage !== update.leverage) changes.push(`Preferred leverage ${current.preferences.leverage}× → ${update.leverage}×`);
        if (current.preferences.isDefault !== update.isDefault) changes.push(update.isDefault ? 'Set as default account' : 'No longer the default account');
        if (changes.length === 0) return state;
        return {
          ...state,
          accounts: state.accounts.map((a) => {
            if (a.id === update.accountId) {
              return {
                ...a,
                name: update.name,
                preferences: { ...a.preferences, allowedPairs: [...update.allowedPairs], leverage: update.leverage, isDefault: update.isDefault }
              };
            }
            return update.isDefault ? { ...a, preferences: { ...a.preferences, isDefault: false } } : a;
          }),
          connectionEvents: withEvents(state, [makeEvent(update.accountId, action.at, 'Preferences changed', 'info', changes.join(' · '))])
        };
      }

    case 'replaceCredentials':{
        const { accountId, ok, maskedKey, reason, at } = action;
        if (!ok) {
          return {
            ...state,
            connectionEvents: withEvents(state, [makeEvent(accountId, at, 'Credential replacement failed', 'failure', `${reason ?? 'Validation failed'} Existing masked reference kept.`)])
          };
        }
        return {
          ...state,
          accounts: patchAccount(state, accountId, (a) => ({
            ...a,
            maskedKey: maskedKey ?? a.maskedKey,
            scenario: isCredentialScenario(a.scenario) ? 'healthy' : a.scenario,
            needsRevalidation: false,
            lastValidation: { at, ok: true },
            lastSyncAt: at,
            lastSyncAttempt: { at, ok: true }
          })),
          connectionEvents: withEvents(state, [
          makeEvent(accountId, at, 'Validation completed', 'success', '7 of 7 simulated checks passed'),
          makeEvent(accountId, at, 'Demo credentials replaced', 'success', `New masked reference ${maskedKey}`)]
          )
        };
      }

    case 'recordValidation':{
        const { accountId, ok, reason, failedCheckId, purpose, at } = action;
        const events: ConnectionEvent[] = [
        makeEvent(accountId, at, ok ? 'Validation completed' : 'Validation failed', ok ? 'success' : 'failure', ok ? '7 of 7 simulated checks passed' : reason ?? 'A required check failed')];

        if (ok) events.push(makeEvent(accountId, at, 'Synchronization completed', 'success', 'Included in validation'));else
        if (failedCheckId === 'sync') events.push(makeEvent(accountId, at, 'Synchronization failed', 'failure', 'Last successful sync kept'));
        if (purpose === 'resume') {
          events.push(
            ok ?
            makeEvent(accountId, at, 'New entries resumed', 'success', 'Connection and synchronization checks passed') :
            makeEvent(accountId, at, 'Resume blocked', 'failure', 'New entries stay paused until checks pass')
          );
        }
        if (purpose === 'reconnect') {
          events.push(
            ok ?
            makeEvent(accountId, at, 'Reconnected', 'success', 'New entries stay paused until resumed') :
            makeEvent(accountId, at, 'Reconnect failed', 'failure', reason ?? 'Validation failed')
          );
        }
        return {
          ...state,
          accounts: patchAccount(state, accountId, (a) => ({
            ...a,
            lastValidation: { at, ok, reason },
            ...(ok ? { lastSyncAt: at, lastSyncAttempt: { at, ok: true }, needsRevalidation: false } : {}),
            ...(!ok && failedCheckId === 'sync' ? { lastSyncAttempt: { at, ok: false, reason } } : {}),
            ...(ok && purpose === 'resume' ? { entriesPaused: false } : {}),
            ...(ok && purpose === 'reconnect' ? { disconnected: false } : {})
          })),
          connectionEvents: withEvents(state, events)
        };
      }

    case 'pauseEntries':
      return {
        ...state,
        accounts: patchAccount(state, action.accountId, (a) => ({ ...a, entriesPaused: true })),
        connectionEvents: withEvents(state, [
        makeEvent(action.accountId, action.at, 'New entries paused', 'info', 'Existing positions remain monitored and protected in this simulation')]
        )
      };

    case 'setScenario':{
        const current = state.accounts.find((a) => a.id === action.accountId);
        if (!current || current.scenario === action.scenario) return state;
        const recovering = action.scenario === 'healthy';
        return {
          ...state,
          accounts: patchAccount(state, action.accountId, (a) => ({
            ...a,
            scenario: action.scenario,
            needsRevalidation: recovering ? true : a.needsRevalidation
          })),
          connectionEvents: withEvents(state, [
          makeEvent(
            action.accountId,
            action.at,
            'Demo scenario changed',
            recovering ? 'info' : 'failure',
            recovering ?
            'Healthy connection — validation and synchronization required before entries resume' :
            `${scenarioLabel(action.scenario)} — new entries blocked`
          )]
          )
        };
      }

    case 'disconnect':
      return {
        ...state,
        accounts: patchAccount(state, action.accountId, (a) => ({ ...a, disconnected: true, entriesPaused: true })),
        connectionEvents: withEvents(state, [
        makeEvent(action.accountId, action.at, 'Disconnected', 'info', 'New entries paused · trading history retained')]
        )
      };

    case 'addFunds':
      if (state.transfers.some((t) => t.id === `trf-${action.accountId}-${action.at}`)) return state;
      return snapshot({
        ...state,
        transfers: [...state.transfers, { id: `trf-${action.accountId}-${action.at}`, accountId: action.accountId, amount: action.amount, at: action.at }],
        connectionEvents: withEvents(state, [
        makeEvent(action.accountId, action.at, 'Virtual funds added', 'success', `+${formatNumber(action.amount)} USDT external paper transfer — not trading P&L`)]
        )
      }, action.accountId, action.at, 'Virtual funds added');

    case 'reset':
      return alignPricesToPositions(createInitialState(state.role));

    default:
      return state;
  }
}