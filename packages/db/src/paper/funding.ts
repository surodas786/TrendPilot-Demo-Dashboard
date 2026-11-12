import { and, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { Decimal, fundingAmount } from '@trendpilot/domain';
import type { Db, Executor } from '../client';
import { completeJob, enqueueJob, type JobRow } from '../jobs';
import { fundingRates, instruments, marketQuotes, paperFunding, positionExits, positions } from '../schema';
import { book } from './accounts';

/**
 * REP-02 simulated funding for paper positions. Only a SETTLED rate (public funding history or a
 * fixture) is booked; a predicted rate from the ticker never is. Each settlement books once per
 * position: `paper_funding` is unique on (position, settlement) and the ledger row on its key, so
 * replaying the rate or re-running the job books nothing new.
 */

export const PAPER_FUNDING_JOB = 'paper.funding';
/** The settlement mark must be no older than this before the settlement time. */
const MARK_MAX_AGE_MS = 15 * 60_000;

export interface FundingSummary {
  instrumentId: string;
  settledAt: string;
  positions: number;
  booked: number;
  alreadyBooked: number;
  /** Positions open at settlement with no usable mark price (funding stays unavailable). */
  noMark: number;
}

/** Stores a settled rate and queues its booking. Idempotent per (contract, settlement). */
export async function recordFundingRate(db: Db, r: { instrumentId: string; settledAt: Date; rate: string; source: 'FIXTURE' | 'MEXC_PUBLIC' }): Promise<{ created: boolean }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(fundingRates)
      .values({ instrumentId: r.instrumentId, settledAt: r.settledAt, rate: new Decimal(r.rate).toFixed(), source: r.source })
      .onConflictDoNothing()
      .returning({ id: fundingRates.instrumentId });
    await enqueueJob(tx, {
      kind: PAPER_FUNDING_JOB,
      dedupeKey: `${PAPER_FUNDING_JOB}:${r.instrumentId}:${r.settledAt.toISOString()}`,
      payload: { instrumentId: r.instrumentId, settledAt: r.settledAt.toISOString() },
      runAfter: r.settledAt
    });
    return { created: rows.length > 0 };
  });
}

/** Mark at settlement: the newest quote at or before it (within 15 min). */
async function settlementMark(db: Executor, instrumentId: string, settledAt: Date): Promise<string | null> {
  const [q] = await db
    .select({ mark: marketQuotes.mark, asOf: marketQuotes.asOf })
    .from(marketQuotes)
    .where(and(eq(marketQuotes.instrumentId, instrumentId), lte(marketQuotes.asOf, settledAt), gt(marketQuotes.asOf, new Date(settledAt.getTime() - MARK_MAX_AGE_MS))))
    .orderBy(desc(marketQuotes.asOf))
    .limit(1);
  return q?.mark ?? null;
}

/** Positions open at the settlement instant, with the contracts they held then. */
export async function positionsOpenAt(db: Executor, instrumentId: string, at: Date) {
  const rows = await db
    .select()
    .from(positions)
    // Simulated funding is Paper only: MEXC charges Live funding itself (synced into the Live wallet).
    .where(and(eq(positions.instrumentId, instrumentId), eq(positions.mode, 'PAPER'), lte(positions.openedAt, at), or(isNull(positions.closedAt), gt(positions.closedAt, at))));
  const out: { position: (typeof rows)[number]; contracts: string }[] = [];
  for (const p of rows) {
    // Contracts at `at` = now remaining + everything exited after `at`.
    const [later] = await db
      .select({ c: sql<string>`coalesce(sum(${positionExits.contracts}), 0)` })
      .from(positionExits)
      .where(and(eq(positionExits.positionId, p.id), gt(positionExits.filledAt, at)));
    const contracts = new Decimal(p.contracts).plus(later?.c ?? 0);
    if (contracts.gt(0)) out.push({ position: p, contracts: contracts.toFixed() });
  }
  return out;
}

export async function processPaperFunding(db: Db, job: JobRow): Promise<FundingSummary> {
  const { instrumentId, settledAt: iso } = job.payload as { instrumentId: string; settledAt: string };
  const settledAt = new Date(iso);
  const summary: FundingSummary = { instrumentId, settledAt: iso, positions: 0, booked: 0, alreadyBooked: 0, noMark: 0 };
  const [rate] = await db.select().from(fundingRates).where(and(eq(fundingRates.instrumentId, instrumentId), eq(fundingRates.settledAt, settledAt)));
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
  if (!rate || !inst) {
    await db.transaction(async (tx) => completeJob(tx, job));
    return summary;
  }
  const mark = await settlementMark(db, instrumentId, settledAt);
  const open = await positionsOpenAt(db, instrumentId, settledAt);
  summary.positions = open.length;
  for (const { position: p, contracts } of open) {
    if (!mark) {
      summary.noMark += 1;
      continue;
    }
    const { notional, amount } = fundingAmount(p.side as 'LONG' | 'SHORT', contracts, inst.contractMultiplier, mark, rate.rate);
    const booked = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(paperFunding)
        .values({ ownerId: p.ownerId, paperAccountId: p.paperAccountId, positionId: p.id, instrumentId, settledAt, rate: rate.rate, contracts, markPrice: mark, notional, amount, source: rate.source })
        .onConflictDoNothing({ target: [paperFunding.positionId, paperFunding.settledAt] })
        .returning({ id: paperFunding.id });
      if (!row) return false;
      await book(tx, { id: p.paperAccountId, ownerId: p.ownerId }, [
        {
          kind: 'FUNDING',
          bucket: 'WALLET',
          amount,
          refType: 'paper_funding',
          refId: `funding:${p.id}:${iso}`,
          memo: `Simulated funding ${new Decimal(rate.rate).times(100).toFixed()}% at ${iso} (${rate.source})`
        }
      ]);
      return true;
    });
    if (booked) summary.booked += 1;
    else summary.alreadyBooked += 1;
  }
  await db.transaction(async (tx) => completeJob(tx, job));
  return summary;
}
