import { round2 } from './accountMath';
import type { ClosedTrade, Position } from '../types/trading';

export interface RealizedBreakdown {
  gross: number;
  entryFees: number | null;
  exitFees: number;
  fundingReceived: number;
  fundingPaid: number;
  fundingRecorded: boolean;
  net: number;
  exitQty: number;
  exits: ClosedTrade[];
}

/** Realized activity attributed to one position (partial and final closing fills, recorded entry fees). */
export function realizedFor(ledger: ClosedTrade[], positionId: string): RealizedBreakdown {
  const linked = ledger.filter((l) => l.positionId === positionId);
  const exits = linked.filter((l) => l.kind === 'partial' || l.kind === 'final');
  const fees = linked.filter((l) => l.kind === 'entry-fee');
  const sum = (list: ClosedTrade[], f: (l: ClosedTrade) => number) => round2(list.reduce((a, l) => a + f(l), 0));
  const gross = sum(exits, (l) => l.grossPnl);
  const exitFees = sum(exits, (l) => l.commission);
  const entryFees = fees.length ? sum(fees, (l) => l.commission) : null;
  const fundingReceived = sum(linked, (l) => l.fundingReceived);
  const fundingPaid = sum(linked, (l) => l.fundingPaid);
  return {
    gross,
    entryFees,
    exitFees,
    fundingReceived,
    fundingPaid,
    fundingRecorded: linked.some((l) => l.fundingPaid !== 0 || l.fundingReceived !== 0),
    net: round2(gross - exitFees - (entryFees ?? 0) + fundingReceived - fundingPaid),
    exitQty: exits.reduce((a, l) => a + (l.quantity ?? 0), 0),
    exits
  };
}

export function originalQuantity(p: Position): number {
  return Number((p.quantity + p.closedQuantity).toFixed(p.quantityDecimals));
}