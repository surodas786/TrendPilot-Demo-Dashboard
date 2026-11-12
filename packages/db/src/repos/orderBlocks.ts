import { and, asc, eq, sql } from 'drizzle-orm';
import {
  DomainError,
  ErrorCode,
  normDecimal,
  type BlockStatus,
  type OrderBlockCreate,
  type OrderBlockDto,
  type OrderBlockSettings,
  type Weekday
} from '@trendpilot/domain';
import type { Executor } from '../client';
import { instruments, orderBlocks } from '../schema';

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
    takeProfit: r.takeProfit as OrderBlockDto['takeProfit'],
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
  takeProfit: s.takeProfit,
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
     */
    async update(id: string, expectedRevision: number, settings: OrderBlockSettings, o: { trailingConverted?: boolean } = {}): Promise<WriteResult> {
      if (!isUuid(id)) return { ok: false, reason: 'NOT_FOUND' };
      const rows = await db
        .update(orderBlocks)
        .set({
          ...settingsColumns(settings),
          ...(o.trailingConverted ? { trailingConversionRequired: false } : {}),
          revision: sql`${orderBlocks.revision} + 1`,
          updatedAt: sql`now()`
        })
        .where(and(owned(id), eq(orderBlocks.revision, expectedRevision)))
        .returning({ id: orderBlocks.id });
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
