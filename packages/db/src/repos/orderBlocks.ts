import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  DomainError,
  ErrorCode,
  normDecimal,
  type BlockMode,
  type BlockStatus,
  type OrderBlockCreate,
  type OrderBlockDto,
  type OrderBlockSettings,
  type Weekday
} from '@trendpilot/domain';
import type { Executor } from '../client';
import { instruments, jobs, orderBlocks, orderIntents, paperAccounts, positions, signalDecisions } from '../schema';

/** Order intent states that are not finished yet (same set the entry and exit paths use). */
const UNFINISHED_INTENTS = ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID_RE.test(v);

type Row = typeof orderBlocks.$inferSelect;

function toDto(r: Row, inst: { symbol: string; exchange: string }): OrderBlockDto {
  return {
    id: r.id,
    instrumentId: r.instrumentId,
    symbol: inst.symbol,
    exchange: inst.exchange,
    strategyVersionId: r.strategyVersionId,
    mode: r.mode,
    direction: r.direction,
    orderCostUsdt: normDecimal(r.orderCostUsdt),
    leverage: r.leverage,
    marginMode: r.marginMode,
    stop: r.stop as OrderBlockDto['stop'],
    takeProfitLong: r.takeProfitLong as OrderBlockDto['takeProfitLong'],
    takeProfitShort: r.takeProfitShort as OrderBlockDto['takeProfitShort'],
    trailing: r.trailing as OrderBlockDto['trailing'],
    weekdays: r.weekdays as Weekday[],
    timezone: r.timezone,
    tradingWindow: r.tradingWindowStart && r.tradingWindowEnd ? { start: r.tradingWindowStart, end: r.tradingWindowEnd } : null,
    allowAdds: r.allowAdds,
    maxAdds: r.maxAdds,
    risk: r.risk as OrderBlockDto['risk'],
    status: r.status,
    revision: r.revision,
    trailingConversionRequired: r.trailingConversionRequired,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString()
  };
}

function isUniqueViolation(e: unknown): boolean {
  const codeOf = (x: unknown) => (x && typeof x === 'object' && 'code' in x ? (x as { code: unknown }).code : undefined);
  return codeOf(e) === '23505' || codeOf((e as { cause?: unknown })?.cause) === '23505';
}

const settingsColumns = (s: OrderBlockSettings) => ({
  strategyVersionId: s.strategyVersionId,
  direction: s.direction,
  orderCostUsdt: s.orderCostUsdt,
  leverage: s.leverage,
  marginMode: s.marginMode,
  stop: s.stop,
  takeProfitLong: s.takeProfitLong,
  takeProfitShort: s.takeProfitShort,
  trailing: s.trailing,
  weekdays: s.weekdays,
  // Omitted (an older client) keeps the stored window on update; create defaults to All day.
  ...(s.tradingWindow !== undefined ? { tradingWindowStart: s.tradingWindow?.start ?? null, tradingWindowEnd: s.tradingWindow?.end ?? null } : {}),
  allowAdds: s.allowAdds,
  maxAdds: s.maxAdds,
  risk: s.risk
});

export type WriteResult = { ok: true; block: OrderBlockDto } | { ok: false; reason: 'NOT_FOUND' | 'REVISION_CONFLICT' };

/**
 * IAM-02: the only way to reach order blocks. Every statement is constrained to
 * `owner_id = ownerId`, where ownerId comes from the server-side session, so an
 * unowned ID behaves exactly like a missing one.
 */
export function orderBlocksFor(db: Executor, ownerId: string) {
  // Archived (removed) blocks are invisible to the investor: not listed, not editable, not resumable.
  const owned = (id: string) => and(eq(orderBlocks.id, id), eq(orderBlocks.ownerId, ownerId), isNull(orderBlocks.archivedAt));
  const select = () =>
    db
      .select({ b: orderBlocks, symbol: instruments.symbol, exchange: instruments.exchange })
      .from(orderBlocks)
      .innerJoin(instruments, eq(instruments.id, orderBlocks.instrumentId));

  async function get(id: string): Promise<OrderBlockDto | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await select().where(owned(id)).limit(1);
    return row && toDto(row.b, row);
  }

  /** Distinguishes a stale revision from "not yours / not there" after a guarded write missed. */
  async function missReason(id: string): Promise<'NOT_FOUND' | 'REVISION_CONFLICT'> {
    const [row] = await db.select({ id: orderBlocks.id }).from(orderBlocks).where(owned(id)).limit(1);
    return row ? 'REVISION_CONFLICT' : 'NOT_FOUND';
  }

  return {
    get,

    /**
     * Open positions and unfinished orders this block manages (they keep the block's mode).
     * `lockMode` (inside a transaction): first lock the owner's account row for that mode, the
     * same row an entry locks before it reserves an order, so no entry can start in between. An
     * account that does not exist yet is not created; nothing can be open on it.
     */
    async activity(id: string, opts: { lockMode?: BlockMode } = {}): Promise<{ openPositions: number; pendingOrders: number }> {
      if (!isUuid(id)) return { openPositions: 0, pendingOrders: 0 };
      if (opts.lockMode) {
        await db
          .select({ id: paperAccounts.id })
          .from(paperAccounts)
          .where(and(eq(paperAccounts.ownerId, ownerId), eq(paperAccounts.mode, opts.lockMode)))
          .for('update');
      }
      const [[p], [o]] = await Promise.all([
        db.select({ n: count() }).from(positions).where(and(eq(positions.orderBlockId, id), eq(positions.ownerId, ownerId), eq(positions.status, 'OPEN'))),
        db.select({ n: count() }).from(orderIntents).where(and(eq(orderIntents.orderBlockId, id), eq(orderIntents.ownerId, ownerId), inArray(orderIntents.state, [...UNFINISHED_INTENTS])))
      ]);
      return { openPositions: Number(p?.n ?? 0), pendingOrders: Number(o?.n ?? 0) };
    },

    /** The owner's block for a pair in a given mode (one per pair and mode), if any. */
    async idFor(instrumentId: string, mode: BlockMode): Promise<string | null> {
      const [row] = await db
        .select({ id: orderBlocks.id })
        .from(orderBlocks)
        .where(and(eq(orderBlocks.ownerId, ownerId), eq(orderBlocks.instrumentId, instrumentId), eq(orderBlocks.mode, mode), isNull(orderBlocks.archivedAt)))
        .limit(1);
      return row?.id ?? null;
    },

    async list(): Promise<OrderBlockDto[]> {
      const rows = await select().where(and(eq(orderBlocks.ownerId, ownerId), isNull(orderBlocks.archivedAt))).orderBy(asc(instruments.symbol), asc(orderBlocks.mode));
      return rows.map((r) => toDto(r.b, r));
    },

    async create(input: OrderBlockCreate, timezone: string): Promise<OrderBlockDto> {
      try {
        const [row] = await db
          .insert(orderBlocks)
          .values({ ...settingsColumns(input), ownerId, instrumentId: input.instrumentId, mode: input.mode, timezone, status: 'PAUSED' })
          .returning({ id: orderBlocks.id });
        const created = await get(row!.id);
        return created!;
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new DomainError(409, ErrorCode.DUPLICATE_BLOCK, 'You already have an order block for this pair and mode.');
        }
        throw e;
      }
    },

    /**
     * CFG-03 optimistic concurrency: applies only when the stored revision matches.
     * `trailingConverted`: the save carried trailing settings validated under Trailing Take
     * Profit rules, so a legacy trailing stop is converted and entries are no longer held.
     * `mode`: switch the block to this trading mode (checked by the caller). The block is paused
     * so the investor resumes it explicitly in the new mode.
     */
    async update(id: string, expectedRevision: number, settings: OrderBlockSettings, o: { trailingConverted?: boolean; mode?: BlockMode } = {}): Promise<WriteResult> {
      if (!isUuid(id)) return { ok: false, reason: 'NOT_FOUND' };
      let rows: { id: string }[];
      try {
        rows = await db
          .update(orderBlocks)
          .set({
            ...settingsColumns(settings),
            ...(o.trailingConverted ? { trailingConversionRequired: false } : {}),
            ...(o.mode ? { mode: o.mode, status: 'PAUSED' as const } : {}),
            revision: sql`${orderBlocks.revision} + 1`,
            updatedAt: sql`now()`
          })
          .where(and(owned(id), eq(orderBlocks.revision, expectedRevision)))
          .returning({ id: orderBlocks.id });
      } catch (e) {
        if (isUniqueViolation(e)) throw new DomainError(409, ErrorCode.DUPLICATE_BLOCK, 'You already have an order block for this pair and mode.');
        throw e;
      }
      if (rows.length === 0) return { ok: false, reason: await missReason(id) };
      return { ok: true, block: (await get(id))! };
    },

    /**
     * Why this block cannot be removed now (empty = removable), and whether trade or signal
     * history references it (then it is archived, not deleted). Inside a transaction, `lock`
     * first locks the owner's account row for the block's mode (the row an entry locks before
     * it reserves an order) and the block row, so nothing can start between check and removal.
     */
    async removalCheck(id: string, opts: { lock?: boolean } = {}): Promise<{ block: OrderBlockDto | undefined; reasons: BlockRemovalReason[]; history: boolean }> {
      const block = await get(id);
      if (!block) return { block: undefined, reasons: [], history: false };
      if (opts.lock) {
        await db.select({ id: paperAccounts.id }).from(paperAccounts).where(and(eq(paperAccounts.ownerId, ownerId), eq(paperAccounts.mode, block.mode))).for('update');
        await db.select({ id: orderBlocks.id }).from(orderBlocks).where(owned(id)).for('update');
      }
      const fresh = opts.lock ? await get(id) : block;
      if (!fresh) return { block: undefined, reasons: [], history: false };
      const [[open], [unfinished], [reversal], [decisions], [intents], [allPositions]] = await Promise.all([
        db.select({ n: count() }).from(positions).where(and(eq(positions.orderBlockId, id), eq(positions.ownerId, ownerId), eq(positions.status, 'OPEN'))),
        db.select({ n: count() }).from(orderIntents).where(and(eq(orderIntents.orderBlockId, id), eq(orderIntents.ownerId, ownerId), inArray(orderIntents.state, [...UNFINISHED_INTENTS]))),
        // A close-and-reverse waiting to reopen: the close is done but the new entry is not queued yet.
        db
          .select({ n: count() })
          .from(jobs)
          .innerJoin(orderIntents, sql`${orderIntents.id}::text = ${jobs.payload}->>'closeIntentId'`)
          .where(and(eq(jobs.kind, 'paper.reverse'), inArray(jobs.status, ['PENDING', 'RUNNING']), eq(orderIntents.orderBlockId, id))),
        db.select({ n: count() }).from(signalDecisions).where(eq(signalDecisions.orderBlockId, id)),
        db.select({ n: count() }).from(orderIntents).where(eq(orderIntents.orderBlockId, id)),
        db.select({ n: count() }).from(positions).where(eq(positions.orderBlockId, id))
      ]);
      const reasons: BlockRemovalReason[] = [];
      if (fresh.status === 'ACTIVE') reasons.push({ code: 'ACTIVE', text: 'Active: it can take new entries. Pause it first.' });
      if (Number(open?.n ?? 0)) reasons.push({ code: 'OPEN_POSITION', text: `${open!.n} open position(s) are managed by it (stop loss, take profit, closes).` });
      if (Number(unfinished?.n ?? 0)) reasons.push({ code: 'UNRESOLVED_ORDER', text: `${unfinished!.n} order(s) are not finished yet (submitted, partially filled or awaiting reconciliation).` });
      if (Number(reversal?.n ?? 0)) reasons.push({ code: 'REVERSAL_PENDING', text: 'A close-and-reverse is still being processed.' });
      const history = Number(decisions?.n ?? 0) + Number(intents?.n ?? 0) + Number(allPositions?.n ?? 0) > 0;
      return { block: fresh, reasons, history };
    },

    /**
     * Removes a block that `removalCheck` cleared (call it with `lock` in the same transaction).
     * With history it is archived (kept for trade and signal history, reversible); without any it
     * is deleted. The shared instrument is never touched.
     */
    async remove(id: string, history: boolean): Promise<'ARCHIVED' | 'DELETED' | 'NOT_FOUND'> {
      if (!isUuid(id)) return 'NOT_FOUND';
      if (history) {
        const rows = await db
          .update(orderBlocks)
          .set({ archivedAt: sql`now()`, status: 'PAUSED', revision: sql`${orderBlocks.revision} + 1`, updatedAt: sql`now()` })
          .where(owned(id))
          .returning({ id: orderBlocks.id });
        return rows.length ? 'ARCHIVED' : 'NOT_FOUND';
      }
      const rows = await db.delete(orderBlocks).where(owned(id)).returning({ id: orderBlocks.id });
      return rows.length ? 'DELETED' : 'NOT_FOUND';
    },

    async setStatus(id: string, expectedRevision: number, status: BlockStatus): Promise<WriteResult> {
      if (!isUuid(id)) return { ok: false, reason: 'NOT_FOUND' };
      const rows = await db
        .update(orderBlocks)
        .set({ status, revision: sql`${orderBlocks.revision} + 1`, updatedAt: sql`now()` })
        .where(and(owned(id), eq(orderBlocks.revision, expectedRevision)))
        .returning({ id: orderBlocks.id });
      if (rows.length === 0) return { ok: false, reason: await missReason(id) };
      return { ok: true, block: (await get(id))! };
    }
  };
}

export type OrderBlockRepo = ReturnType<typeof orderBlocksFor>;

/** Why an order block is kept when the investor asks to remove it. */
export interface BlockRemovalReason {
  code: 'ACTIVE' | 'OPEN_POSITION' | 'UNRESOLVED_ORDER' | 'REVERSAL_PENDING';
  text: string;
}
