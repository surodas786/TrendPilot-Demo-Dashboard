import { BACKFILL_GAP, DEFAULT_NOTIFICATION_PREFS, SYNC_STREAMS } from '../data/financeConfig';
import { round2, summarizeAccount } from '../utils/accountMath';
import { formatClock } from '../utils/clock';
import { accountOpenAt } from '../utils/ledger';
import { reservedMarginFor } from '../utils/orders';
import type { DemoState } from './demoReducer';
import type { Discrepancy, EquitySnapshot, FundingSettlement, NotificationCategory, NotificationPrefs, SyncStream, SyncStreamId, TestNotification } from '../types/finance';
import type { DemoAccount, Direction } from '../types/trading';

export type FinanceAction =
{type: 'applySettlement';settlementId: string;accountId: string;pair: string;positionId: string | null;snapshot: {quantity: number;price: number;direction: Direction;};ratePct: number;effectiveAt: number;at: number;} |
{type: 'recordCorrection';discrepancyId: string;reason: string;at: number;} |
{type: 'setSourceOffset';accountId: string;stream: SyncStreamId;amount: number;} |
{type: 'markNotificationRead';key: string;lastAt: number;} |
{type: 'markAllNotificationsRead';items: {key: string;lastAt: number;}[];} |
{type: 'setNotificationPrefs';userId: string;prefs: NotificationPrefs;} |
{type: 'sendTestNotification';userId: string;accountId: string | null;category: NotificationCategory;title: string;at: number;} |
{type: 'setEmailFailing';on: boolean;at: number;};

const FINANCE_ACTIONS = new Set(['applySettlement', 'recordCorrection', 'setSourceOffset', 'markNotificationRead', 'markAllNotificationsRead', 'setNotificationPrefs', 'sendTestNotification', 'setEmailFailing']);

export function isFinanceAction(a: {type: string;}): a is FinanceAction {
  return FINANCE_ACTIONS.has(a.type);
}

export interface FinanceState {
  fundingSettlements: FundingSettlement[];
  discrepancies: Discrepancy[];
  sourceOffsets: Record<string, {stream: SyncStreamId;amount: number;} | undefined>;
  syncStreams: Record<string, Record<SyncStreamId, SyncStream>>;
  equitySnapshots: EquitySnapshot[];
  notificationPrefs: Record<string, NotificationPrefs>;
  notificationReads: Record<string, number>;
  testNotifications: TestNotification[];
  emailFailWindows: {from: number;to: number | null;}[];
}

export function initialFinanceState(accounts: DemoAccount[]): FinanceState {
  return {
    fundingSettlements: [],
    discrepancies: [],
    sourceOffsets: {},
    syncStreams: {},
    // The opening demo balance is the start-of-day equity; no positions were open before it.
    equitySnapshots: accounts.map((a) => ({ id: `snap-${a.id}-open`, accountId: a.id, at: accountOpenAt(a), wallet: a.openingEquity, equity: a.openingEquity, unrealized: 0, source: 'Opening demo balance' })),
    notificationPrefs: {},
    notificationReads: {},
    testNotifications: [],
    emailFailWindows: []
  };
}

let seq = 0;
const nid = (p: string, at: number) => `${p}-${at.toString(36)}-${seq += 1}`;

/** Stored streams, or the state implied by the account's last connection sync. */
export function streamsFor(state: DemoState, accountId: string): Record<SyncStreamId, SyncStream> {
  const stored = state.syncStreams[accountId];
  if (stored) return stored;
  const a = state.accounts.find((x) => x.id === accountId);
  const attempt = a?.lastSyncAttempt ?? null;
  const base = (id: SyncStreamId): SyncStream => ({
    lastAttemptAt: attempt?.at ?? null,
    lastSuccessAt: a?.lastSyncAt ?? null,
    status: id === 'backfill' ? 'partial' : attempt ? attempt.ok ? 'ok' : 'failed' : a?.lastSyncAt ? 'ok' : 'never',
    missingPeriod: id === 'backfill' ? BACKFILL_GAP : null,
    finding: id === 'backfill' ? 'Only the current reporting day is available' : 'Not yet reconciled in this session'
  });
  return Object.fromEntries(SYNC_STREAMS.map((s) => [s.id, base(s.id)])) as Record<SyncStreamId, SyncStream>;
}

export function snapshot(state: DemoState, accountId: string, at: number, source: string): DemoState {
  const a = state.accounts.find((x) => x.id === accountId);
  if (!a) return state;
  const s = summarizeAccount(
    a,
    state.positions.filter((p) => p.accountId === accountId),
    state.closedTrades.filter((t) => t.accountId === accountId),
    state.transfers.filter((t) => t.accountId === accountId),
    reservedMarginFor(state.orders, accountId)
  );
  const snap: EquitySnapshot = { id: nid('snap', at), accountId, at, wallet: s.walletBalance, equity: s.currentEquity, unrealized: s.unrealized, source };
  return { ...state, equitySnapshots: [...state.equitySnapshots, snap] };
}

export function localFundingNet(state: DemoState, accountId: string): number {
  return round2(state.closedTrades.filter((t) => t.accountId === accountId).reduce((acc, t) => acc + t.fundingReceived - t.fundingPaid, 0));
}

/** Applies a finance synchronization result after the connection sync has run. Failure never overwrites the last success. */
export function applyFinanceSync(state: DemoState, accountId: string, at: number, ok: boolean, reason?: string): DemoState {
  const prev = streamsFor(state, accountId);
  const offset = state.sourceOffsets[accountId];
  const next = { ...prev };
  let discrepancies = state.discrepancies;
  SYNC_STREAMS.forEach(({ id }) => {
    const p = prev[id];
    if (!ok) {
      next[id] = { ...p, lastAttemptAt: at, status: 'failed', finding: `${reason ?? 'Synchronization failed'} — last successful data kept, balances unchanged` };
      return;
    }
    if (id === 'backfill') {
      next[id] = { ...p, lastAttemptAt: at, lastSuccessAt: at, status: 'partial', missingPeriod: BACKFILL_GAP, finding: 'Current day matched · earlier history unavailable' };
      return;
    }
    if (offset && offset.stream === id) {
      const local = id === 'funding' ? localFundingNet(state, accountId) : 0;
      const source = round2(local + offset.amount);
      const open = discrepancies.find((d) => d.accountId === accountId && d.stream === id && d.status === 'open');
      if (!open) discrepancies = [...discrepancies, { id: nid('DIF', at), accountId, stream: id, label: id === 'funding' ? 'Net funding (all recorded settlements)' : id, local, source, foundAt: at, status: 'open' }];
      next[id] = { ...p, lastAttemptAt: at, lastSuccessAt: at, status: 'partial', finding: `Difference ${round2(source - local).toFixed(2)} USDT — reports provisional until reconciled` };
      return;
    }
    next[id] = { ...p, lastAttemptAt: at, lastSuccessAt: at, status: 'ok', missingPeriod: null, finding: 'Local records match the simulated source' };
  });
  const s: DemoState = { ...state, syncStreams: { ...state.syncStreams, [accountId]: next }, discrepancies };
  return ok ? snapshot(s, accountId, at, 'Successful synchronization') : s;
}

export function financeReducer(state: DemoState, action: FinanceAction): DemoState {
  switch (action.type) {
    case 'applySettlement':{
        if (state.fundingSettlements.some((x) => x.id === action.settlementId)) return state; // Already recorded
        const acct = state.accounts.find((a) => a.id === action.accountId);
        if (!acct) return state;
        const p = action.positionId ? state.positions.find((x) => x.id === action.positionId) : undefined;
        const { quantity, price, direction } = action.snapshot;
        const notional = round2(quantity * price);
        const longPays = action.ratePct > 0;
        const pays = direction === 'long' ? longPays : !longPays;
        const magnitude = round2(notional * Math.abs(action.ratePct) / 100);
        const amount = pays ? -magnitude : magnitude;
        const attributed = Boolean(p && p.managed !== false);
        const ledgerId = `led-${action.settlementId}`;
        const late = action.at - action.effectiveAt > 3_600_000;
        const settlement: FundingSettlement = { id: action.settlementId, accountId: acct.id, pair: action.pair, positionId: p?.id ?? null, direction, attributed, effectiveAt: action.effectiveAt, recordedAt: action.at, ratePct: action.ratePct, quantity, price, notional, amount, ledgerId, late };
        const s: DemoState = {
          ...state,
          fundingSettlements: [settlement, ...state.fundingSettlements],
          closedTrades: [
          ...state.closedTrades,
          {
            id: ledgerId,
            kind: 'funding',
            settlementId: settlement.id,
            accountId: acct.id,
            strategyId: attributed && p ? p.strategyId : 'unallocated',
            pair: action.pair,
            direction,
            positionId: attributed ? p?.id : undefined,
            closedAt: formatClock(action.effectiveAt),
            at: action.effectiveAt,
            recordedAt: action.at,
            grossPnl: 0,
            commission: 0,
            fundingPaid: amount < 0 ? magnitude : 0,
            fundingReceived: amount > 0 ? magnitude : 0
          }]

        };
        return snapshot(s, acct.id, action.at, `Funding settlement ${settlement.id}`);
      }
    case 'recordCorrection':{
        const d = state.discrepancies.find((x) => x.id === action.discrepancyId);
        if (!d || d.status !== 'open') return state;
        const delta = round2(d.source - d.local);
        const id = `COR-${d.id}`;
        const s: DemoState = {
          ...state,
          discrepancies: state.discrepancies.map((x) => x.id === d.id ? { ...x, status: 'corrected', correctionId: id } : x),
          sourceOffsets: { ...state.sourceOffsets, [d.accountId]: undefined },
          closedTrades: [
          ...state.closedTrades,
          { id, kind: 'correction', correctsId: d.id, reason: action.reason, accountId: d.accountId, strategyId: 'unallocated', pair: '—', direction: 'long', closedAt: formatClock(action.at), at: action.at, recordedAt: action.at, grossPnl: 0, commission: 0, fundingPaid: delta < 0 ? -delta : 0, fundingReceived: delta > 0 ? delta : 0 }]

        };
        return snapshot(s, d.accountId, action.at, `Correction ${id}`);
      }
    case 'setSourceOffset':
      return { ...state, sourceOffsets: { ...state.sourceOffsets, [action.accountId]: { stream: action.stream, amount: action.amount } } };
    case 'markNotificationRead':
      return { ...state, notificationReads: { ...state.notificationReads, [action.key]: action.lastAt } };
    case 'markAllNotificationsRead':
      return { ...state, notificationReads: { ...state.notificationReads, ...Object.fromEntries(action.items.map((i) => [i.key, i.lastAt])) } };
    case 'setNotificationPrefs':
      return { ...state, notificationPrefs: { ...state.notificationPrefs, [action.userId]: action.prefs } };
    case 'sendTestNotification':
      return { ...state, testNotifications: [{ id: nid('TST', action.at), userId: action.userId, accountId: action.accountId, at: action.at, category: action.category, title: action.title }, ...state.testNotifications] };
    case 'setEmailFailing':{
        const open = state.emailFailWindows.find((w) => w.to === null);
        if (action.on && !open) return { ...state, emailFailWindows: [...state.emailFailWindows, { from: action.at, to: null }] };
        if (!action.on && open) return { ...state, emailFailWindows: state.emailFailWindows.map((w) => w === open ? { ...w, to: action.at } : w) };
        return state;
      }
    default:
      return state;
  }
}

export function prefsFor(state: DemoState, userId: string): NotificationPrefs {
  return state.notificationPrefs[userId] ?? DEFAULT_NOTIFICATION_PREFS;
}