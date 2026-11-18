import { and, eq, sql } from 'drizzle-orm';
import { Decimal, exchangeUnavailableReason, isPaperExchange, isTradableExchange, PAPER_POLICY } from '@trendpilot/domain';
import type { Executor } from '../client';
import { ledgerEntries, paperAccounts } from '../schema';

/**
 * Paper balances (SCP-03). Every balance change is a ledger row; an account column moves only
 * when its ledger row is newly inserted, so a retry can never book the same movement twice.
 */

export type PaperAccountRow = typeof paperAccounts.$inferSelect;
export type Bucket = 'WALLET' | 'POSITION_MARGIN' | 'ORDER_RESERVE';

export interface LedgerInput {
  kind: string;
  bucket: Bucket;
  amount: string;
  refType: string;
  refId: string;
  memo?: string;
}

const column = { WALLET: paperAccounts.walletBalance, POSITION_MARGIN: paperAccounts.positionMargin, ORDER_RESERVE: paperAccounts.orderReserve };

/** Books entries once. Returns the entries that were newly booked. */
export async function book(tx: Executor, account: Pick<PaperAccountRow, 'id' | 'ownerId'>, entries: LedgerInput[]): Promise<LedgerInput[]> {
  const booked: LedgerInput[] = [];
  for (const e of entries) {
    const rows = await tx
      .insert(ledgerEntries)
      .values({ ownerId: account.ownerId, paperAccountId: account.id, ...e })
      .onConflictDoNothing({ target: [ledgerEntries.paperAccountId, ledgerEntries.kind, ledgerEntries.refId] })
      .returning({ id: ledgerEntries.id });
    if (!rows.length) continue;
    const delta = sql`${column[e.bucket]} + ${e.amount}::numeric`;
    const set =
      e.bucket === 'WALLET' ? { walletBalance: delta } : e.bucket === 'POSITION_MARGIN' ? { positionMargin: delta } : { orderReserve: delta };
    await tx
      .update(paperAccounts)
      .set({ ...set, revision: sql`${paperAccounts.revision} + 1`, updatedAt: sql`now()` })
      .where(eq(paperAccounts.id, account.id));
    booked.push(e);
  }
  return booked;
}

export type AccountMode = 'PAPER' | 'LIVE';
export type AccountExchange = 'MEXC' | 'BITUNIX' | 'LIGHTER';

/**
 * The account an order uses. Live trades on the instrument's exchange (MEXC or Bitunix). Paper uses
 * the MEXC Paper account (USDT), except Lighter pairs, which use their own isolated Lighter Paper
 * account (USDC). An exchange that cannot trade Live (Lighter) never maps to any Live account.
 */
export const accountExchangeFor = (mode: string, instrumentExchange: string | null | undefined): AccountExchange => {
  if (mode === 'LIVE') {
    if (instrumentExchange && !isTradableExchange(instrumentExchange)) throw new Error(exchangeUnavailableReason(instrumentExchange) ?? 'exchange not tradable');
    return instrumentExchange === 'BITUNIX' ? 'BITUNIX' : 'MEXC';
  }
  return instrumentExchange === 'LIGHTER' ? 'LIGHTER' : 'MEXC';
};

/** Settlement currency of an account: Lighter Paper is USDC; MEXC and Bitunix accounts are USDT. */
export const accountCurrencyFor = (exchange: AccountExchange): 'USDT' | 'USDC' => (exchange === 'LIGHTER' ? 'USDC' : 'USDT');

/**
 * Locks (creating on first use) the investor's account for a mode and exchange. All reservations go through
 * this lock. A PAPER account starts with the fixture balance; a LIVE account starts at zero and
 * follows the synced MEXC balance (`syncLiveBalance`).
 */
export async function lockPaperAccount(tx: Executor, ownerId: string, mode: AccountMode = 'PAPER', exchange: AccountExchange = 'MEXC', o: { lighterLiveLedger?: boolean } = {}): Promise<PaperAccountRow> {
  if (mode === 'PAPER' && !isPaperExchange(exchange)) throw new Error('Paper accounts are MEXC or Lighter accounts.');
  // A Live Lighter account (USDC) exists only to follow a VERIFIED Lighter connection's snapshot
  // (Step 4 sync, explicit opt-in). Every other path — and every Live Lighter entry — is refused.
  if (mode === 'LIVE' && exchange === 'LIGHTER' && !o.lighterLiveLedger) throw new Error(exchangeUnavailableReason('LIGHTER') ?? 'Lighter Live is not available');
  const inserted = await tx
    .insert(paperAccounts)
    .values({ ownerId, mode, exchange, walletBalance: '0', currency: accountCurrencyFor(exchange) })
    .onConflictDoNothing({ target: [paperAccounts.ownerId, paperAccounts.mode, paperAccounts.exchange] })
    .returning();
  if (inserted[0] && mode === 'PAPER') {
    await book(tx, inserted[0], [{ kind: 'OPENING_BALANCE', bucket: 'WALLET', amount: PAPER_POLICY.startingBalanceUsdt, refType: 'paper_account', refId: inserted[0].id, memo: exchange === 'LIGHTER' ? 'Fixture paper balance (USDC, Lighter Paper)' : 'Fixture paper balance' }]);
  }
  const [row] = await tx
    .select()
    .from(paperAccounts)
    .where(and(eq(paperAccounts.ownerId, ownerId), eq(paperAccounts.mode, mode), eq(paperAccounts.exchange, exchange)))
    .for('update');
  return row!;
}

/**
 * Balance available for a new order. Paper: wallet − margin − reservations. Live: the same, and
 * never more than MEXC's last synced available-to-open balance minus local reservations; a Live
 * account that was never synced has nothing available.
 */
export const availableOf = (a: Pick<PaperAccountRow, 'walletBalance' | 'positionMargin' | 'orderReserve'> & Partial<Pick<PaperAccountRow, 'mode' | 'exchangeAvailable'>>) => {
  const local = new Decimal(a.walletBalance).minus(a.positionMargin).minus(a.orderReserve);
  if (a.mode !== 'LIVE') return local.toFixed();
  if (a.exchangeAvailable === null || a.exchangeAvailable === undefined) return '0';
  return Decimal.max(0, Decimal.min(local, new Decimal(a.exchangeAvailable).minus(a.orderReserve))).toFixed();
};
