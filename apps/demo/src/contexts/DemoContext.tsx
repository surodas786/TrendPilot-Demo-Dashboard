import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState } from 'react';
import { toast } from 'sonner';
import { saveUserDirectory } from '../utils/userDirectory';
import { loadDemoState, saveDemoState } from '../utils/demoPersistence';
import type { TokenSignalInput } from './signals/tokenExecution';
import type { UserLink } from '../types/users';
import { createInitialState, demoReducer } from './demoReducer';
import type { ConnectionUpdate, DemoState, ValidationPurpose } from './demoReducer';
import { summarizeAccount } from '../utils/accountMath';
import { pendingEntriesFromOrders, reservedMarginFor } from '../utils/orders';
import type { CloseItemInput } from './executionReducer';
import { ownerOf } from '../data/demoUsers';
import type { DemoUser, SignalInput, SignalRoute, SignalScenarioId } from '../types/signals';
import type { NotificationItem } from '../types/trading';
import type { FinanceAction } from './financeReducer';
import { buildNotificationGroups } from '../utils/notificationCenter';
import type { NotificationGroup } from '../utils/notificationCenter';
import type { FixtureId } from '../types/execution';
import { simNow } from '../utils/clock';
import { computeRiskUsage, riskSettingsFor } from '../utils/riskEngine';
import type { RiskUsage } from '../utils/riskEngine';
import { accountConnectionReasons } from '../utils/subscriptionStatus';
import type { BlockReason } from '../utils/subscriptionStatus';
import type { ExitPlanSaveKind } from './strategyReducer';
import type { AuditEntry, RiskSettings } from '../types/risk';
import type { ExitPlan } from '../types/exitPlan';
import type { Subscription } from '../types/strategy';
import type {
  AccountSummary,
  ClosedTrade,
  ConnectionScenario,
  DemoAccount,
  Position,
  PreviewRole } from
'../types/trading';

interface DemoContextValue {
  state: DemoState;
  accounts: DemoAccount[];
  /** Account currently selected in the top bar. */
  account: DemoAccount;
  accountById: (id: string) => DemoAccount | undefined;
  accountName: (id: string) => string;
  accountPositions: Position[];
  accountTrades: ClosedTrade[];
  summary: AccountSummary;
  summaries: Record<string, AccountSummary>;
  unreadCount: number;
  setRole: (role: PreviewRole) => void;
  setExchange: (exchangeId: string) => void;
  setAccount: (accountId: string) => void;
  setStrategyFilter: (strategyId: string) => void;
  setReportingDate: (date: string) => void;
  refresh: () => void;
  selectPosition: (positionId: string | null) => void;
  /** Workspace-wide pause of new entries (separate from account-level pauses). */
  isPaused: boolean;
  togglePause: () => void;
  /** Idempotent: the same requestId is processed once, so repeated clicks cannot duplicate a close. */
  submitClose: (requestId: string, accountId: string, kind: 'full' | 'partial' | 'all', items: CloseItemInput[]) => void;
  reconcileOrder: (orderId: string) => void;
  cancelEntryOrder: (orderId: string) => void;
  tightenStop: (positionId: string, newStop: number) => void;
  loadFixture: (accountId: string, fixture: FixtureId) => void;
  restoreAccount: (accountId: string) => void;
  markNotificationsRead: () => void;
  resetDemo: () => void;
  addConnection: (account: DemoAccount) => void;
  updateConnection: (update: ConnectionUpdate) => void;
  replaceCredentials: (payload: {accountId: string;ok: boolean;maskedKey?: string;reason?: string;}) => void;
  recordValidation: (payload: {accountId: string;ok: boolean;reason?: string;failedCheckId?: string;purpose: ValidationPurpose;}) => void;
  syncAccount: (accountId: string) => void;
  pauseEntries: (accountId: string) => void;
  setScenario: (accountId: string, scenario: ConnectionScenario) => void;
  disconnect: (accountId: string) => void;
  addFunds: (accountId: string, amount: number) => void;
  subscriptions: Subscription[];
  riskSettingsOf: (accountId: string) => RiskSettings;
  riskUsage: Record<string, RiskUsage>;
  /** Account-level reasons blocking new entries: connection, account pause and risk limits (excludes the workspace pause). */
  accountEntryReasons: (accountId: string) => BlockReason[];
  saveSubscription: (subscription: Subscription, isNew: boolean) => void;
  setSubscriptionPaused: (id: string, paused: boolean) => void;
  archiveSubscription: (id: string) => void;
  updateRiskSettings: (accountId: string, settings: RiskSettings, changes: string[], exceeded: string[]) => void;
  recordAudit: (entry: Omit<AuditEntry, 'id' | 'at'>) => void;
  setSimFeeRate: (pct: number) => void;
  exitPlans: ExitPlan[];
  exitPlanById: (id: string | null | undefined) => ExitPlan | undefined;
  saveExitPlan: (plan: ExitPlan, kind: ExitPlanSaveKind) => void;
  archiveExitPlan: (id: string) => void;
  attachExitPlan: (subscriptionId: string, planId: string) => void;
  activateSubscription: (id: string) => void;
  /** Selected trader preview user. Trader screens show only this user's records. */
  currentUser: DemoUser;
  notifications: NotificationItem[];
  setTraderUser: (userId: string) => void;
  submitSignal: (input: SignalInput) => void;
  fillEntryRemainder: (orderId: string) => void;
  setPaperPrice: (pair: string, price: number) => void;
  setSharedPrices: (prices: Record<string, number>) => void;
  executeTokenSignal: (input: TokenSignalInput) => void;
  closeTokenPosition: (positionId: string) => void;
  /** Creates a local simulated trading account for the selected subscriber with an explicit starting balance. */
  createSimAccount: (args: {name: string;environment: 'paper' | 'live';balance: number;}) => string;
  updateRoute: (route: SignalRoute) => void;
  addRoute: (route: SignalRoute) => void;
  setUserEntriesPaused: (userId: string, paused: boolean) => void;
  setUserSuspended: (userId: string, suspended: boolean) => void;
  setGlobalHalt: (on: boolean) => void;
  setComposerDraft: (draft: SignalInput | null) => void;
  loadSignalScenario: (id: SignalScenarioId, prefill: SignalInput, pre?: SignalInput) => void;
  loadPresentation: () => void;
  /** Applies the next ordered presentation price once; ignored if the step already moved. */
  advancePresentation: (expectedStep: number) => void;
  /** Derived, grouped notifications for the selected trader user. */
  notificationGroups: NotificationGroup[];
  dispatchFinance: (action: DistributiveOmit<FinanceAction, 'at'>) => void;
  runFinanceSync: (accountId: string) => void;
  createUser: (user: DemoUser, link: UserLink) => void;
  editUser: (userId: string, name: string, email: string) => void;
  issueUserLink: (link: UserLink) => void;
  completeSetup: (linkId: string) => void;
  completeReset: (linkId: string) => void;
  setUserAccess: (userId: string, status: 'active' | 'suspended') => void;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const DemoContext = createContext<DemoContextValue | null>(null);

export function DemoProvider({ children }: {children: React.ReactNode;}) {
  const [boot] = useState(() => loadDemoState(createInitialState()));
  const [state, dispatch] = useReducer(demoReducer, boot.state);

  useEffect(() => {
    if (boot.unreadable) toast.error('Saved demo data could not be read', { description: 'Started from the original demo data. A copy of the unreadable data was kept in this browser.' });
  }, [boot.unreadable]);

  // Persist only non-sensitive user records and link states (never passwords).
  useEffect(() => {
    saveUserDirectory(state.users, state.userLinks);
  }, [state.users, state.userLinks]);

  // The whole shared store is saved (fictional records only — no credentials exist in it).
  useEffect(() => {
    saveDemoState(state);
  }, [state]);

  const summaries = useMemo(() => {
    const result: Record<string, AccountSummary> = {};
    state.accounts.forEach((a) => {
      result[a.id] = summarizeAccount(
        a,
        state.positions.filter((p) => p.accountId === a.id),
        state.closedTrades.filter((t) => t.accountId === a.id),
        state.transfers.filter((t) => t.accountId === a.id),
        reservedMarginFor(state.orders, a.id)
      );
    });
    return result;
  }, [state.accounts, state.positions, state.closedTrades, state.transfers, state.orders]);

  const riskUsage = useMemo(() => {
    const result: Record<string, RiskUsage> = {};
    state.accounts.forEach((a) => {
      result[a.id] = computeRiskUsage(
        summaries[a.id],
        state.positions.filter((p) => p.accountId === a.id),
        [...state.pendingEntries.filter((e) => e.accountId === a.id), ...pendingEntriesFromOrders(state.orders, a.id)],
        riskSettingsFor(state.riskSettings, a.id)
      );
    });
    return result;
  }, [state.accounts, state.positions, state.pendingEntries, state.orders, state.riskSettings, summaries]);

  const riskSettingsOf = useCallback((id: string) => riskSettingsFor(state.riskSettings, id), [state.riskSettings]);
  const accountEntryReasons = useCallback(
    (id: string): BlockReason[] => {
      const acct = state.accounts.find((a) => a.id === id);
      const user = state.users.find((u) => u.id === ownerOf(acct));
      const admin: BlockReason[] = [];
      if (state.globalHalt) admin.push({ id: 'global-halt', text: 'Global entry halt by an administrator' });
      if (user?.status === 'suspended') admin.push({ id: 'user-suspended', text: 'User suspended — new entries blocked' });else
      if (user?.entriesPaused) admin.push({ id: 'user-paused', text: 'User entries paused by an administrator' });
      return [...admin, ...accountConnectionReasons(acct), ...(riskUsage[id]?.blockers ?? []).map((b) => ({ id: `risk-${b.id}`, text: b.reason }))];
    },
    [state.accounts, state.users, state.globalHalt, riskUsage]
  );

  // Trader screens only ever see the selected demo user's records.
  const visibleAccounts = useMemo(() => state.accounts.filter((a) => ownerOf(a) === state.traderUserId), [state.accounts, state.traderUserId]);
  const visibleIds = useMemo(() => new Set(visibleAccounts.map((a) => a.id)), [visibleAccounts]);
  const visibleSubscriptions = useMemo(() => state.subscriptions.filter((s) => visibleIds.has(s.accountId)), [state.subscriptions, visibleIds]);
  const visibleExitPlans = useMemo(() => state.exitPlans.filter((p) => visibleIds.has(p.accountId)), [state.exitPlans, visibleIds]);
  const visibleNotifications = useMemo(() => state.notifications.filter((n) => (n.userId ?? 'user-1') === state.traderUserId), [state.notifications, state.traderUserId]);
  const currentUser = state.users.find((u) => u.id === state.traderUserId) ?? state.users[0];
  const notificationGroups = useMemo(() => {
    const blocked = Object.fromEntries(Object.entries(riskUsage).map(([id, u]) => [id, u.blockers.some((b) => b.id === 'daily-loss')]));
    return buildNotificationGroups(state, state.traderUserId, blocked, simNow());
  }, [state, riskUsage]);

  const account = visibleAccounts.find((a) => a.id === state.accountId) ?? visibleAccounts[0] ?? state.accounts[0];
  const accountPositions = useMemo(() => state.positions.filter((p) => p.accountId === account.id), [state.positions, account.id]);
  const accountTrades = useMemo(() => state.closedTrades.filter((t) => t.accountId === account.id), [state.closedTrades, account.id]);

  const accountById = useCallback((id: string) => state.accounts.find((a) => a.id === id), [state.accounts]);
  const exitPlanById = useCallback((id: string | null | undefined) => id ? state.exitPlans.find((p) => p.id === id) : undefined, [state.exitPlans]);
  const accountName = useCallback((id: string) => state.accounts.find((a) => a.id === id)?.name ?? 'Unknown account', [state.accounts]);

  const actions = useMemo(
    () => ({
      setRole: (role: PreviewRole) => dispatch({ type: 'setRole', role }),
      setExchange: (exchangeId: string) => dispatch({ type: 'setExchange', exchangeId }),
      setAccount: (accountId: string) => dispatch({ type: 'setAccount', accountId }),
      setStrategyFilter: (strategyId: string) => dispatch({ type: 'setStrategyFilter', strategyId }),
      setReportingDate: (date: string) => dispatch({ type: 'setReportingDate', date }),
      refresh: () => dispatch({ type: 'refresh', at: simNow() }),
      selectPosition: (positionId: string | null) => dispatch({ type: 'selectPosition', positionId }),
      togglePause: () => dispatch({ type: 'toggleGlobalPause' }),
      submitClose: (requestId: string, accountId: string, kind: 'full' | 'partial' | 'all', items: CloseItemInput[]) =>
      dispatch({ type: 'submitClose', requestId, accountId, kind, items, at: simNow() }),
      reconcileOrder: (orderId: string) => dispatch({ type: 'reconcileOrder', orderId, at: simNow() }),
      cancelEntryOrder: (orderId: string) => dispatch({ type: 'cancelEntryOrder', orderId, at: simNow() }),
      tightenStop: (positionId: string, newStop: number) => dispatch({ type: 'tightenStop', positionId, newStop, at: simNow() }),
      loadFixture: (accountId: string, fixture: FixtureId) => dispatch({ type: 'loadFixture', accountId, fixture, at: simNow() }),
      restoreAccount: (accountId: string) => dispatch({ type: 'restoreAccount', accountId, at: simNow() }),
      markNotificationsRead: () => dispatch({ type: 'markNotificationsRead' }),
      resetDemo: () => dispatch({ type: 'reset' }),
      addConnection: (acc: DemoAccount) => dispatch({ type: 'addConnection', account: acc, at: simNow() }),
      updateConnection: (update: ConnectionUpdate) => dispatch({ type: 'updateConnection', update, at: simNow() }),
      replaceCredentials: (p: {accountId: string;ok: boolean;maskedKey?: string;reason?: string;}) =>
      dispatch({ type: 'replaceCredentials', ...p, at: simNow() }),
      recordValidation: (p: {accountId: string;ok: boolean;reason?: string;failedCheckId?: string;purpose: ValidationPurpose;}) =>
      dispatch({ type: 'recordValidation', ...p, at: simNow() }),
      syncAccount: (accountId: string) => dispatch({ type: 'syncAccount', accountId, at: simNow() }),
      pauseEntries: (accountId: string) => dispatch({ type: 'pauseEntries', accountId, at: simNow() }),
      setScenario: (accountId: string, scenario: ConnectionScenario) => dispatch({ type: 'setScenario', accountId, scenario, at: simNow() }),
      disconnect: (accountId: string) => dispatch({ type: 'disconnect', accountId, at: simNow() }),
      addFunds: (accountId: string, amount: number) => dispatch({ type: 'addFunds', accountId, amount, at: simNow() }),
      saveSubscription: (subscription: Subscription, isNew: boolean) => dispatch({ type: 'saveSubscription', subscription, isNew, at: simNow() }),
      setSubscriptionPaused: (id: string, paused: boolean) => dispatch({ type: 'setSubscriptionPaused', id, paused, at: simNow() }),
      archiveSubscription: (id: string) => dispatch({ type: 'archiveSubscription', id, at: simNow() }),
      updateRiskSettings: (accountId: string, settings: RiskSettings, changes: string[], exceeded: string[]) =>
      dispatch({ type: 'updateRiskSettings', accountId, settings, changes, exceeded, at: simNow() }),
      recordAudit: (entry: Omit<AuditEntry, 'id' | 'at'>) => dispatch({ type: 'recordAudit', entry, at: simNow() }),
      setSimFeeRate: (pct: number) => dispatch({ type: 'setSimFeeRate', pct }),
      saveExitPlan: (plan: ExitPlan, kind: ExitPlanSaveKind) => dispatch({ type: 'saveExitPlan', plan, kind, at: simNow() }),
      archiveExitPlan: (id: string) => dispatch({ type: 'archiveExitPlan', id, at: simNow() }),
      attachExitPlan: (subscriptionId: string, planId: string) => dispatch({ type: 'attachExitPlan', subscriptionId, planId, at: simNow() }),
      activateSubscription: (id: string) => dispatch({ type: 'activateSubscription', id, at: simNow() }),
      setTraderUser: (userId: string) => dispatch({ type: 'setTraderUser', userId }),
      submitSignal: (input: SignalInput) => dispatch({ type: 'submitSignal', input, at: simNow() }),
      fillEntryRemainder: (orderId: string) => dispatch({ type: 'fillEntryRemainder', orderId, at: simNow() }),
      // One shared price per pair: revalues every position and runs each position's own exit rules once.
      setPaperPrice: (pair: string, price: number) => dispatch({ type: 'applySharedPrice', pair, price, at: simNow() }),
      setSharedPrices: (prices: Record<string, number>) => dispatch({ type: 'setSharedPrices', prices, at: simNow() }),
      executeTokenSignal: (input: TokenSignalInput) => dispatch({ type: 'executeTokenSignal', input, at: simNow() }),
      closeTokenPosition: (positionId: string) => dispatch({ type: 'closeTokenPosition', positionId, at: simNow() }),
      updateRoute: (route: SignalRoute) => dispatch({ type: 'updateRoute', route, at: simNow() }),
      addRoute: (route: SignalRoute) => dispatch({ type: 'addRoute', route, at: simNow() }),
      setUserEntriesPaused: (userId: string, paused: boolean) => dispatch({ type: 'setUserEntriesPaused', userId, paused, at: simNow() }),
      setUserSuspended: (userId: string, suspended: boolean) => dispatch({ type: 'setUserSuspended', userId, suspended, at: simNow() }),
      setGlobalHalt: (on: boolean) => dispatch({ type: 'setGlobalHalt', on, at: simNow() }),
      setComposerDraft: (draft: SignalInput | null) => dispatch({ type: 'setComposerDraft', draft }),
      loadSignalScenario: (id: SignalScenarioId, prefill: SignalInput, pre?: SignalInput) => dispatch({ type: 'loadSignalScenario', id, prefill, pre, at: simNow() }),
      loadPresentation: () => dispatch({ type: 'loadPresentation', at: simNow() }),
      advancePresentation: (expectedStep: number) => dispatch({ type: 'advancePresentation', at: simNow(), expectedStep }),
      dispatchFinance: (action: DistributiveOmit<FinanceAction, 'at'>) => dispatch({ ...action, at: simNow() } as FinanceAction),
      runFinanceSync: (accountId: string) => dispatch({ type: 'runFinanceSync', accountId, at: simNow() }),
      createUser: (user: DemoUser, link: UserLink) => dispatch({ type: 'createUser', user, link, at: simNow() }),
      editUser: (userId: string, name: string, email: string) => dispatch({ type: 'editUser', userId, name, email, at: simNow() }),
      issueUserLink: (link: UserLink) => dispatch({ type: 'issueUserLink', link, at: simNow() }),
      completeSetup: (linkId: string) => dispatch({ type: 'completeSetup', linkId, at: simNow() }),
      completeReset: (linkId: string) => dispatch({ type: 'completeReset', linkId, at: simNow() }),
      setUserAccess: (userId: string, status: 'active' | 'suspended') => dispatch({ type: 'setUserAccess', userId, status, at: simNow() })
    }),
    []
  );

  const template = state.accounts[0];
  const createSimAccount = useCallback(
    ({ name, environment, balance }: {name: string;environment: 'paper' | 'live';balance: number;}) => {
      const at = simNow();
      const id = `acct-${environment}-${at.toString(36)}`;
      const acc: DemoAccount = {
        ...template,
        id,
        name,
        descriptor: environment === 'live' ? 'Live — simulated · MEXC Futures' : 'Paper simulation · MEXC Futures',
        environment,
        openingEquity: balance,
        maskedKey: environment === 'live' ? 'linked simulated connection' : 'paper · no key',
        createdAt: at,
        preferences: { ...template.preferences, isDefault: false },
        scenario: 'healthy',
        disconnected: false,
        entriesPaused: false,
        needsRevalidation: false,
        lastSyncAt: at,
        lastSyncAttempt: { at, ok: true },
        lastValidation: { at, ok: true }
      };
      dispatch({ type: 'addConnection', account: acc, at });
      return id;
    },
    [template]
  );

  const value: DemoContextValue = {
    state,
    createSimAccount,
    accounts: visibleAccounts,
    account,
    currentUser,
    notifications: visibleNotifications,
    accountById,
    accountName,
    accountPositions,
    accountTrades,
    summary: summaries[account.id],
    summaries,
    unreadCount: notificationGroups.filter((g) => g.visible && !g.read).length,
    notificationGroups,
    isPaused: state.globalPaused,
    subscriptions: visibleSubscriptions,
    riskSettingsOf,
    riskUsage,
    accountEntryReasons,
    exitPlans: visibleExitPlans,
    exitPlanById,
    ...actions
  };

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemo(): DemoContextValue {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error('useDemo must be used within DemoProvider');
  return ctx;
}