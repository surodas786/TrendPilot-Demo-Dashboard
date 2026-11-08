import { eq, sql } from 'drizzle-orm';
import { Decimal, PAPER_POLICY } from '@trendpilot/domain';
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

/** Locks (creating on first use) the investor's paper account. All reservations go through this lock. */
export async function lockPaperAccount(tx: Executor, ownerId: string): Promise<PaperAccountRow> {
  const inserted = await tx
    .insert(paperAccounts)
    .values({ ownerId, walletBalance: '0' })
    .onConflictDoNothing({ target: paperAccounts.ownerId })
    .returning();
  if (inserted[0]) {
    await book(tx, inserted[0], [{ kind: 'OPENING_BALANCE', bucket: 'WALLET', amount: PAPER_POLICY.startingBalanceUsdt, refType: 'paper_account', refId: inserted[0].id, memo: 'Fixture paper balance' }]);
  }
  const [row] = await tx.select().from(paperAccounts).where(eq(paperAccounts.ownerId, ownerId)).for('update');
  return row!;
}

export const availableOf = (a: Pick<PaperAccountRow, 'walletBalance' | 'positionMargin' | 'orderReserve'>) =>
  new Decimal(a.walletBalance).minus(a.positionMargin).minus(a.orderReserve).toFixed();
