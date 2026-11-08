import { round2 } from './accountMath';
import { dayTimeToMs } from './clock';
import { isWorking } from './orders';
import type { OrderRecord, TradeRecord } from '../types/execution';
import type { FundingSettlement } from '../types/finance';
import type { ClosedTrade, DemoAccount, PaperTransfer } from '../types/trading';

/** Start of the demo reporting day (Nov 4, 2026 00:00 Asia/Dhaka). */
export const DAY_START = new Date('2026-11-04T00:00:00+06:00').getTime();

export type LedgerType =
'opening' |
'transfer' |
'realized' |
'entry-fee' |
'exit-fee' |
'funding-received' |
'funding-paid' |
'correction' |
'margin-allocated' |
'margin-released' |
'reservation';

export const LEDGER_TYPE_LABELS: Record<LedgerType, string> = {
  opening: 'Opening balance',
  transfer: 'Virtual funds added',
  realized: 'Realized trading P&L',
  'entry-fee': 'Entry commission',
  'exit-fee': 'Exit commission',
  'funding-received': 'Funding received',
  'funding-paid': 'Funding paid',
  correction: 'Explicit correction',
  'margin-allocated': 'Position margin allocated',
  'margin-released': 'Position margin released',
  reservation: 'Order margin reserved'
};

export const FINANCIAL_TYPES: LedgerType[] = ['opening', 'transfer', 'realized', 'entry-fee', 'exit-fee', 'funding-received', 'funding-paid', 'correction'];

export interface LedgerRelated {
  kind: 'trade' | 'position' | 'order' | 'settlement' | 'event';
  id: string;
  label: string;
}

export interface LedgerRow {
  id: string;
  sourceId: string;
  effectiveAt: number;
  recordedAt: number;
  accountId: string;
  type: LedgerType;
  pair: string | null;
  related: LedgerRelated | null;
  amount: number;
  running: number | null;
  status: string;
  operational: boolean;
  late: boolean;
}

export function effectiveAt(t: ClosedTrade): number {
  return t.at ?? dayTimeToMs(t.closedAt);
}

export function recordedAt(t: ClosedTrade): number {
  return t.recordedAt ?? effectiveAt(t);
}

export function accountOpenAt(a: DemoAccount): number {
  return Math.max(DAY_START, a.createdAt || DAY_START);
}

interface Sources {
  account: DemoAccount;
  ledger: ClosedTrade[];
  transfers: PaperTransfer[];
  settlements: FundingSettlement[];
  tradeRecords: TradeRecord[];
  orders: OrderRecord[];
}

/** One stable row per financial source event; running balance in effective-time order. */
export function buildLedgerRows(src: Sources): LedgerRow[] {
  const { account } = src;
  const tradeFor = (positionId?: string): LedgerRelated | null => {
    if (!positionId) return null;
    const t = src.tradeRecords.find((r) => r.positionId === positionId);
    return t ? { kind: 'trade', id: positionId, label: t.id } : { kind: 'position', id: positionId, label: `Open position ${positionId}` };
  };
  const rows: LedgerRow[] = [];
  const openAt = accountOpenAt(account);
  const push = (r: Omit<LedgerRow, 'running' | 'operational' | 'late'> & {late?: boolean;}) =>
  rows.push({ ...r, running: null, operational: false, late: r.late ?? false });

  push({ id: `${account.id}:opening`, sourceId: account.id, effectiveAt: openAt, recordedAt: openAt, accountId: account.id, type: 'opening', pair: null, related: null, amount: account.openingEquity, status: 'Opening demo balance' });

  src.transfers.forEach((t) =>
  push({ id: `${t.id}:transfer`, sourceId: t.id, effectiveAt: t.at, recordedAt: t.at, accountId: t.accountId, type: 'transfer', pair: null, related: { kind: 'event', id: t.id, label: 'External paper transfer' }, amount: t.amount, status: 'Recorded · not trading P&L' })
  );

  src.ledger.forEach((l) => {
    const eff = effectiveAt(l);
    const rec = recordedAt(l);
    const late = rec - eff > 60_000;
    const base = { sourceId: l.id, effectiveAt: eff, recordedAt: rec, accountId: l.accountId, pair: l.pair, late };
    if (l.kind === 'correction') {
      const amount = round2(l.grossPnl - l.commission + l.fundingReceived - l.fundingPaid);
      push({ ...base, id: `${l.id}:correction`, type: 'correction', related: l.correctsId ? { kind: 'event', id: l.correctsId, label: `Corrects ${l.correctsId}` } : null, amount, status: l.reason ? `Correction · ${l.reason}` : 'Correction' });
      return;
    }
    if (l.kind === 'funding') {
      const s = src.settlements.find((x) => x.ledgerId === l.id);
      const related: LedgerRelated = { kind: 'settlement', id: l.settlementId ?? l.id, label: l.settlementId ?? l.id };
      const status = `${s?.attributed ? 'Trade-attributed' : 'Unallocated funding'}${late ? ' · late arrival' : ''}`;
      if (l.fundingReceived) push({ ...base, id: `${l.id}:funding-in`, type: 'funding-received', related, amount: l.fundingReceived, status });
      if (l.fundingPaid) push({ ...base, id: `${l.id}:funding-out`, type: 'funding-paid', related, amount: -l.fundingPaid, status });
      return;
    }
    const summary = l.kind === 'opening-summary';
    const status = summary ? 'Historical summary — not itemized' : 'Recorded fill';
    const related = summary ? { kind: 'event' as const, id: l.id, label: 'Opening demo summary' } : tradeFor(l.positionId);
    if (l.kind === 'entry-fee') {
      push({ ...base, id: `${l.id}:fee`, type: 'entry-fee', related, amount: -l.commission, status });
      return;
    }
    if (l.grossPnl !== 0 || !summary) push({ ...base, id: `${l.id}:pnl`, type: 'realized', related, amount: l.grossPnl, status });
    if (l.commission) push({ ...base, id: `${l.id}:fee`, type: 'exit-fee', related, amount: -l.commission, status: summary ? status : 'Recorded fill commission' });
    if (l.fundingReceived) push({ ...base, id: `${l.id}:funding-in`, type: 'funding-received', related, amount: l.fundingReceived, status: summary ? status : 'Recorded with fill' });
    if (l.fundingPaid) push({ ...base, id: `${l.id}:funding-out`, type: 'funding-paid', related, amount: -l.fundingPaid, status: summary ? status : 'Recorded with fill' });
  });

  rows.sort((a, b) => a.effectiveAt - b.effectiveAt || a.recordedAt - b.recordedAt || a.id.localeCompare(b.id));
  let bal = 0;
  rows.forEach((r) => {
    bal = round2(bal + r.amount);
    r.running = bal;
  });

  // Operational events: zero wallet movement, kept out of the running balance.
  src.orders.
  filter((o) => o.purpose === 'entry' && o.accountId === account.id).
  forEach((o) => {
    const first = o.fills[0];
    if (first) rows.push(op(o, `${o.id}:margin`, 'margin-allocated', first.at, 'Margin moved into the position — not an expense'));
    if (isWorking(o)) rows.push(op(o, `${o.id}:reserve`, 'reservation', o.createdAt, 'Unfilled entry reserves available margin'));
  });
  src.tradeRecords.forEach((t) =>
  rows.push({ id: `${t.id}:release`, sourceId: t.id, effectiveAt: t.exitAt, recordedAt: t.exitAt, accountId: t.accountId, type: 'margin-released', pair: t.pair, related: { kind: 'trade', id: t.positionId, label: t.id }, amount: 0, running: null, status: 'Margin returned on full close — not income', operational: true, late: false })
  );
  return rows;
}

function op(o: OrderRecord, id: string, type: LedgerType, at: number, status: string): LedgerRow {
  return { id, sourceId: o.id, effectiveAt: at, recordedAt: at, accountId: o.accountId, type, pair: o.pair, related: { kind: 'order', id: o.id, label: o.id }, amount: 0, running: null, status, operational: true, late: false };
}