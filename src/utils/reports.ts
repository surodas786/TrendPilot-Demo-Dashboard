import { RECON_TOLERANCE } from '../data/financeConfig';
import { round2, summarizeAccount, unrealizedPnl } from './accountMath';
import { accountOpenAt, effectiveAt, recordedAt } from './ledger';
import { reservedMarginFor } from './orders';
import type { DemoState } from '../contexts/demoReducer';
import type { TradeRecord } from '../types/execution';
import type { ClosedTrade } from '../types/trading';

export const REPORT_TIMEZONES = [
{ value: 'Asia/Dhaka', label: 'Asia/Dhaka (UTC+6)' },
{ value: 'UTC', label: 'UTC' }];


export interface ReportFilters {
  from: string;
  to: string;
  tz: string;
  accountIds: string[];
  pair: string;
  strategy: string;
}

const fmtCache: Record<string, Intl.DateTimeFormat> = {};
export function dateKey(ts: number, tz: string): string {
  fmtCache[tz] ??= new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmtCache[tz].format(new Date(ts));
}

/** Start of a calendar day in the given zone (supports Asia/Dhaka and UTC). */
export function dayStart(date: string, tz: string): number {
  return new Date(`${date}T00:00:00${tz === 'UTC' ? 'Z' : '+06:00'}`).getTime();
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let d = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  while (d <= end && out.length < 62) {
    out.push(new Date(d).toISOString().slice(0, 10));
    d += 86_400_000;
  }
  return out;
}

export interface PeriodReport {
  from: string;
  to: string;
  openingEquity: number | null;
  openingWallet: number | null;
  closingEquity: number | null;
  closingWallet: number | null;
  closingIsCurrent: boolean;
  openingUnrealized: number | null;
  closingUnrealized: number | null;
  gross: number;
  entryFees: number;
  exitFees: number;
  commissions: number;
  fundingReceived: number;
  fundingPaid: number;
  attributedFunding: number;
  unallocatedFunding: number;
  netRealized: number;
  corrections: number;
  inflows: number;
  /** Events recorded inside the period but effective before it (changed the wallet after the opening boundary). */
  lateBefore: number;
  tradingChange: number | null;
  expectedChange: number | null;
  difference: number | null;
  tradesOpened: number;
  tradesCompleted: number;
  openPositions: number | null;
  complete: boolean;
  provisional: boolean;
  filteredByMarket: boolean;
  updatedBy: ClosedTrade[];
  entries: ClosedTrade[];
  reconciled: boolean;
}

function matches(t: {pair: string;strategyId: string;}, f: ReportFilters): boolean {
  if (f.pair !== 'all' && t.pair !== f.pair) return false;
  if (f.strategy !== 'all' && t.strategyId !== f.strategy) return false;
  return true;
}

export function computePeriod(state: DemoState, f: ReportFilters, from: string, to: string, now: number): PeriodReport {
  const start = dayStart(from, f.tz);
  const end = dayStart(to, f.tz) + 86_400_000;
  const ids = new Set(f.accountIds);
  const accounts = state.accounts.filter((a) => ids.has(a.id));
  const inRange = (ts: number) => ts >= start && ts < end;
  const ledger = state.closedTrades.filter((t) => ids.has(t.accountId) && matches(t, f));
  const entries = ledger.filter((t) => inRange(effectiveAt(t)));
  const sum = (xs: ClosedTrade[], fn: (t: ClosedTrade) => number) => round2(xs.reduce((a, t) => a + fn(t), 0));
  const regular = entries.filter((t) => t.kind !== 'correction');
  const corrections = sum(entries.filter((t) => t.kind === 'correction'), (t) => t.grossPnl - t.commission + t.fundingReceived - t.fundingPaid);
  const gross = sum(regular, (t) => t.grossPnl);
  const entryFees = sum(regular.filter((t) => t.kind === 'entry-fee'), (t) => t.commission);
  const exitFees = sum(regular.filter((t) => t.kind !== 'entry-fee'), (t) => t.commission);
  const fundingReceived = sum(regular, (t) => t.fundingReceived);
  const fundingPaid = sum(regular, (t) => t.fundingPaid);
  const fundingNet = (t: ClosedTrade) => t.fundingReceived - t.fundingPaid;
  const attributedFunding = sum(regular.filter((t) => t.positionId), fundingNet);
  const unallocatedFunding = sum(regular.filter((t) => !t.positionId && t.kind === 'funding'), fundingNet);
  const commissions = round2(entryFees + exitFees);
  const netRealized = round2(gross - commissions + fundingReceived - fundingPaid);
  const allLedger = state.closedTrades.filter((t) => ids.has(t.accountId));
  const lateBefore = sum(allLedger.filter((t) => effectiveAt(t) < start && recordedAt(t) >= start && recordedAt(t) < end), (t) => t.grossPnl - t.commission + t.fundingReceived - t.fundingPaid);
  const inflows = round2(state.transfers.filter((t) => ids.has(t.accountId) && inRange(t.at)).reduce((a, t) => a + t.amount, 0));

  // Boundaries: only recorded snapshots — never invented.
  let openingEquity: number | null = 0;
  let openingWallet: number | null = 0;
  let openingUnrealized: number | null = 0;
  accounts.forEach((a) => {
    const snap = state.equitySnapshots.find((s) => s.accountId === a.id && s.at === start);
    const opened = accountOpenAt(a);
    if (snap) {
      openingEquity = openingEquity === null ? null : openingEquity + snap.equity;
      openingWallet = openingWallet === null ? null : openingWallet + snap.wallet;
      openingUnrealized = openingUnrealized === null ? null : openingUnrealized + snap.unrealized;
    } else if (opened > start && opened < end) {

      // Account created within the period: zero before, opening balance counted as an inflow.
    } else {openingEquity = openingWallet = openingUnrealized = null;
    }
  });
  const inflowsWithOpenings = round2(inflows + accounts.filter((a) => accountOpenAt(a) > start && accountOpenAt(a) < end).reduce((x, a) => x + a.openingEquity, 0));

  const closingIsCurrent = now >= start && now < end;
  let closingEquity: number | null = null;
  let closingWallet: number | null = null;
  let closingUnrealized: number | null = null;
  if (closingIsCurrent) {
    closingEquity = closingWallet = closingUnrealized = 0;
    accounts.forEach((a) => {
      const pos = state.positions.filter((p) => p.accountId === a.id);
      const s = summarizeAccount(a, pos, state.closedTrades.filter((t) => t.accountId === a.id), state.transfers.filter((t) => t.accountId === a.id), reservedMarginFor(state.orders, a.id));
      closingEquity = round2((closingEquity as number) + s.currentEquity);
      closingWallet = round2((closingWallet as number) + s.walletBalance);
      closingUnrealized = round2((closingUnrealized as number) + pos.reduce((x, p) => x + unrealizedPnl(p), 0));
    });
  }

  const complete = openingEquity !== null && closingEquity !== null;
  const tradingChange = complete ? round2((closingEquity as unknown as number) - (openingEquity as unknown as number) - inflowsWithOpenings) : null;
  const expectedChange = complete ? round2(netRealized + corrections + lateBefore + ((closingUnrealized as unknown as number) - (openingUnrealized as unknown as number))) : null;
  const difference = tradingChange !== null && expectedChange !== null ? round2(tradingChange - expectedChange) : null;
  const provisional = state.discrepancies.some((d) => ids.has(d.accountId) && d.status === 'open');
  const updatedBy = entries.filter((t) => dateKey(recordedAt(t), f.tz) > dateKey(effectiveAt(t), f.tz));
  const tradesOpened = state.orders.filter((o) => ids.has(o.accountId) && o.purpose === 'entry' && o.fills[0] && inRange(o.fills[0].at) && (f.pair === 'all' || o.pair === f.pair)).length;
  const completed = completedTrades(state.tradeRecords, f, start, end);

  return {
    from,
    to,
    openingEquity,
    openingWallet,
    closingEquity,
    closingWallet,
    closingIsCurrent,
    openingUnrealized,
    closingUnrealized,
    gross,
    entryFees,
    exitFees,
    commissions,
    fundingReceived,
    fundingPaid,
    attributedFunding,
    unallocatedFunding,
    netRealized,
    corrections,
    inflows: inflowsWithOpenings,
    lateBefore,
    tradingChange,
    expectedChange,
    difference,
    tradesOpened,
    tradesCompleted: completed.length,
    openPositions: closingIsCurrent ? state.positions.filter((p) => ids.has(p.accountId) && matches(p, f)).length : null,
    complete,
    provisional,
    filteredByMarket: f.pair !== 'all' || f.strategy !== 'all',
    updatedBy,
    entries,
    reconciled: complete && !provisional && difference !== null && Math.abs(difference) <= RECON_TOLERANCE
  };
}

export function completedTrades(records: TradeRecord[], f: ReportFilters, start: number, end: number): TradeRecord[] {
  const ids = new Set(f.accountIds);
  return records.filter((t) => ids.has(t.accountId) && t.exitAt >= start && t.exitAt < end && matches(t, f));
}

export interface Performance {
  trades: TradeRecord[];
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  net: number;
}

/** Net trade P&L after recorded fees and attributed funding; values rounding to 0.00 are breakeven. */
export function performance(trades: TradeRecord[]): Performance {
  const nets = trades.map((t) => round2(t.net));
  const wins = nets.filter((n) => n > 0);
  const losses = nets.filter((n) => n < 0);
  const avg = (xs: number[]) => xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  return {
    trades,
    wins: wins.length,
    losses: losses.length,
    breakeven: nets.length - wins.length - losses.length,
    winRate: wins.length + losses.length > 0 ? round2(wins.length / (wins.length + losses.length) * 100) : null,
    avgWin: avg(wins),
    avgLoss: avg(losses),
    net: round2(nets.reduce((a, b) => a + b, 0))
  };
}