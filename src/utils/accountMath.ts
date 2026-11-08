import { CLOSING_FEE_RATE } from '../data/mockData';
import type {
  AccountSummary,
  ClosedTrade,
  DemoAccount,
  LedgerTotals,
  PaperTransfer,
  Position } from
'../types/trading';

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Current isolated margin of the remaining position (entry notional ÷ leverage). */
export function positionMargin(p: Position): number {
  return round2(p.quantity * p.entryPrice / p.leverage);
}

/** Notional at entry for the remaining quantity (= current margin × leverage). */
export function entryNotional(p: Position): number {
  return round2(p.quantity * p.entryPrice);
}

export function markNotional(p: Position): number {
  return round2(p.quantity * p.markPrice);
}

export function unrealizedPnl(p: Position): number {
  const sign = p.direction === 'long' ? 1 : -1;
  return round2(sign * p.quantity * (p.markPrice - p.entryPrice));
}

export function closingCommission(p: Position): number {
  return round2(markNotional(p) * CLOSING_FEE_RATE);
}

export function summarizeLedger(positions: Position[], trades: ClosedTrade[]): LedgerTotals {
  const sum = (values: number[]) => round2(values.reduce((acc, v) => acc + v, 0));
  const grossRealized = sum(trades.map((t) => t.grossPnl));
  const commissions = sum(trades.map((t) => t.commission));
  const fundingPaid = sum(trades.map((t) => t.fundingPaid));
  const fundingReceived = sum(trades.map((t) => t.fundingReceived));
  return {
    grossRealized,
    commissions,
    fundingPaid,
    fundingReceived,
    netRealized: round2(grossRealized - commissions + fundingReceived - fundingPaid),
    unrealized: sum(positions.map(unrealizedPnl)),
    usedMargin: sum(positions.map(positionMargin)),
    allocatedCost: sum(positions.map((p) => p.allocatedCost)),
    openPositions: positions.length
  };
}

/** Simulated closing fee on actual fill notional, using the shared simulation fee rate (percent). */
export function closingFee(price: number, quantity: number, feeRatePct: number): number {
  return round2(price * quantity * (feeRatePct / 100));
}

/**
 * Wallet balance = opening equity + paper transfers + net realized P&L.
 * Equity = wallet balance + unrealized P&L.
 * Paper transfers (virtual funds) are external transfers and never count as trading P&L.
 */
export function summarizeAccount(
account: DemoAccount,
positions: Position[],
trades: ClosedTrade[],
transfers: PaperTransfer[],
reservedMargin = 0)
: AccountSummary {
  const ledger = summarizeLedger(positions, trades);
  const transfersIn = round2(transfers.reduce((acc, t) => acc + t.amount, 0));
  const walletBalance = round2(account.openingEquity + transfersIn + ledger.netRealized);
  const currentEquity = round2(walletBalance + ledger.unrealized);
  const base = account.openingEquity + transfersIn;
  const dayChange = round2(currentEquity - base);
  return {
    ...ledger,
    openingEquity: account.openingEquity,
    transfersIn,
    walletBalance,
    currentEquity,
    reservedMargin: round2(reservedMargin),
    // Available margin = equity − used margin − pending entry reservations.
    availableMargin: round2(currentEquity - ledger.usedMargin - reservedMargin),
    dayChange,
    dayChangePct: base > 0 ? round2(dayChange / base * 100) : 0
  };
}