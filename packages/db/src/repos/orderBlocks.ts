import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
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
import { instruments, orderBlocks, orderIntents, paperAccounts, positions } from '../schema';

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
  const owned = (id: string) => and(eq(orderBlocks.id, id), eq(orderBlocks.ownerId, ownerId));
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
        .where(and(eq(orderBlocks.ownerId, ownerId), eq(orderBlocks.instrumentId, instrumentId), eq(orderBlocks.mode, mode)))
        .limit(1);
      return row?.id ?? null;
    },

    async list(): Promise<OrderBlockDto[]> {
      const rows = await select().where(eq(orderBlocks.ownerId, ownerId)).orderBy(asc(instruments.symbol), asc(orderBlocks.mode));
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
