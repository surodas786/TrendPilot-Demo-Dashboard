import { EXAMPLE_PRESET } from '../../data/exitPlans';
import { demoUsers } from '../../data/demoUsers';
import { seedRoutes } from '../../data/signalRoutes';
import { previewMarket } from '../../data/strategyCatalog';
import { DEFAULT_ACCOUNT_SIM } from '../../data/demoFixtures';
import { PRESENTATION_ACCOUNTS, PRESENTATION_ATR, PRESENTATION_PAIR, PRESENTATION_PRICES, PRESENTATION_REMOVED_ACCOUNTS } from '../../data/presentation';
import { accountOpenAt } from '../../utils/ledger';
import { replaceAccountData } from '../executionReducer';
import { applyPaperPrice } from './exitEngine';
import type { DemoState } from '../demoReducer';
import type { ExitPlan } from '../../types/exitPlan';
import type { Subscription } from '../../types/strategy';

/** Loads the documented presentation fixture. Never dispatches a signal. */
export function loadPresentation(state: DemoState, at: number, activate = false): DemoState {
  const removed = new Set(PRESENTATION_REMOVED_ACCOUNTS);
  const ids = new Set(PRESENTATION_ACCOUNTS.map((p) => p.accountId));
  const touched = new Set([...removed, ...ids]);
  const keep = <T extends {accountId: string;},>(list: T[]) => list.filter((x) => !removed.has(x.accountId));
  const dropRecord = <T,>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([k]) => !touched.has(k))) as Record<string, T>;

  let s: DemoState = {
    ...state,
    accounts: state.accounts.filter((a) => !removed.has(a.id)),
    positions: keep(state.positions),
    orders: keep(state.orders),
    closedTrades: keep(state.closedTrades),
    tradeRecords: keep(state.tradeRecords),
    closeRequests: keep(state.closeRequests),
    pendingEntries: keep(state.pendingEntries),
    transfers: keep(state.transfers),
    activity: keep(state.activity),
    signals: keep(state.signals),
    connectionEvents: keep(state.connectionEvents)
  };
  for (const p of PRESENTATION_ACCOUNTS) {
    s = replaceAccountData(s, p.accountId, at, { openingEquity: 5000, positions: [], orders: [], ledger: [], activity: [], signals: [], sim: DEFAULT_ACCOUNT_SIM }, 'Presentation fixture — Shared signal to completed trade');
  }

  const version = seedRoutes[0]?.approvedVersion ?? '1.0';
  const plans: ExitPlan[] = PRESENTATION_ACCOUNTS.map((p) => ({
    id: p.planId,
    familyId: p.planId.replace('-v1', ''),
    version: 1,
    accountId: p.accountId,
    name: 'Partial 1.5R · trail 1R',
    description: EXAMPLE_PRESET.description,
    status: 'valid',
    config: { ...EXAMPLE_PRESET.config },
    example: false,
    createdAt: at,
    updatedAt: at
  }));
  const subs: Subscription[] = PRESENTATION_ACCOUNTS.map((p) => ({
    id: p.subscriptionId,
    label: 'Supertrend · BTC presentation',
    strategyId: seedRoutes[0]?.strategyId ?? 'supertrend-15m',
    version,
    accountId: p.accountId,
    exchangeId: 'mexc',
    pairs: [PRESENTATION_PAIR],
    directions: 'both',
    emaFilter: true,
    orderCost: p.orderCost,
    leverage: p.leverage,
    riskPolicyId: p.accountId,
    exitPlanId: p.planId,
    lifecycle: 'saved',
    paused: false,
    activated: activate,
    createdAt: at,
    updatedAt: at
  }));

  s = {
    ...s,
    accounts: s.accounts.map((a) => {
      const p = PRESENTATION_ACCOUNTS.find((x) => x.accountId === a.id);
      return p ? { ...a, name: p.name, entriesPaused: false, createdAt: Math.min(a.createdAt, at), preferences: { ...a.preferences, allowedPairs: Array.from(new Set([...a.preferences.allowedPairs, PRESENTATION_PAIR])) } } : a;
    }),
    subscriptions: [...s.subscriptions.filter((x) => !touched.has(x.accountId)), ...subs],
    exitPlans: [...s.exitPlans.filter((x) => !touched.has(x.accountId)), ...plans],
    users: s.users.map((u) => {
      if (!PRESENTATION_ACCOUNTS.some((p) => p.userId === u.id)) return u;
      const seed = demoUsers.find((d) => d.id === u.id) ?? u;
      return { ...seed, status: 'active' as const, invitation: 'accepted' as const, entriesPaused: false, workspacePaused: false };
    }),
    traderUserId: 'user-1',
    accountId: 'acct-a',
    selectedPositionId: null,
    globalPaused: false,
    globalHalt: false,
    routes: seedRoutes.map((r) => ({ ...r, symbolMap: { ...r.symbolMap }, allowedActions: [...r.allowedActions] })),
    watermarks: {},
    entryBehavior: {},
    paperPrices: { ...previewMarket, [PRESENTATION_PAIR]: PRESENTATION_PRICES[0] },
    simFeeRatePct: 0.05,
    composerDraft: null,
    signalScenario: null,
    scenarioOverrides: { atr: { [PRESENTATION_PAIR]: PRESENTATION_ATR }, zeroSlippage: true },
    presentation: { loadedAt: at, step: 0, accountIds: PRESENTATION_ACCOUNTS.map((p) => p.accountId) },
    // Finance records for touched accounts restart from a complete opening snapshot.
    fundingSettlements: s.fundingSettlements.filter((x) => !touched.has(x.accountId)),
    discrepancies: s.discrepancies.filter((x) => !touched.has(x.accountId)),
    sourceOffsets: dropRecord(s.sourceOffsets),
    syncStreams: dropRecord(s.syncStreams),
    riskSettings: s.riskSettings,
    equitySnapshots: [
    ...s.equitySnapshots.filter((x) => !touched.has(x.accountId)),
    ...s.accounts.
    filter((a) => ids.has(a.id)).
    map((a) => ({ id: `snap-${a.id}-pres-${at}`, accountId: a.id, at: accountOpenAt(a), wallet: 5000, equity: 5000, unrealized: 0, source: 'Presentation opening balance' }))]

  };
  return s;
}

export function presentationHasExposure(state: DemoState): boolean {
  const p = state.presentation;
  return Boolean(p && state.positions.some((x) => p.accountIds.includes(x.accountId) && x.pair === PRESENTATION_PAIR));
}

/** Applies the next ordered price update once. Index guard prevents duplicate fills. */
export function advancePresentation(state: DemoState, at: number, expectedStep?: number): DemoState {
  const p = state.presentation;
  if (!p || p.step >= PRESENTATION_PRICES.length - 1) return state;
  if (expectedStep !== undefined && expectedStep !== p.step) return state;
  if (!presentationHasExposure(state)) return state;
  const next = p.step + 1;
  const s = applyPaperPrice(state, PRESENTATION_PAIR, PRESENTATION_PRICES[next], at);
  return { ...s, presentation: { ...p, step: next } };
}