import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Decimal } from '@trendpilot/domain';
import type { Db, Executor } from '../client';
import { instruments, simFills, simOrders, simPositions } from '../schema';

/**
 * Paper simulator: the venue for PAPER mode (SCP-03). It behaves like the exchange adapter in
 * §10.2 — `placeOpeningOrderWithStop`, `lookupOrder`, `inspectProtection` — and owns its own
 * tables, written in its own transaction. It never talks to any real exchange; there is no
 * live transport in this codebase.
 *
 * Idempotent by client order ID: resubmitting the same ID returns the original result and never
 * creates a second order or fill.
 */

export interface OpeningRequest {
  paperAccountId: string;
  clientOrderId: string;
  instrumentId: string;
  side: 'LONG' | 'SHORT';
  contracts: string;
  contract: { multiplier: string; qtyStep: string; minQty: string; takerFeeRate: string };
  /** Executable quote at submission; LONG fills at ask, SHORT at bid. */
  quote: { bid: string; ask: string };
  /** EXE-02: exchange-hosted stop carried in the same request. Required. */
  stop: { price: string; basis: string } | null;
  now: Date;
}

export interface SimFill {
  fillId: string;
  contracts: string;
  price: string;
  fee: string;
  filledAt: Date;
}

export type SimResult =
  | { status: 'FILLED'; orderId: string; clientOrderId: string; fill: SimFill; stop: { orderId: string; clientOrderId: string; triggerPrice: string; basis: string; contracts: string; reduceOnly: boolean } }
  | { status: 'REJECTED'; orderId: string; clientOrderId: string; reason: string };

const stopClientId = (clientOrderId: string) => `${clientOrderId}:sl`;

async function resultFor(db: Db, clientOrderId: string): Promise<SimResult | null> {
  const [order] = await db.select().from(simOrders).where(and(eq(simOrders.clientOrderId, clientOrderId), eq(simOrders.kind, 'MARKET_OPEN')));
  if (!order) return null;
  if (order.status === 'REJECTED') return { status: 'REJECTED', orderId: order.id, clientOrderId, reason: order.rejectReason ?? 'REJECTED' };
  const [fill] = await db.select().from(simFills).where(eq(simFills.orderId, order.id));
  const [stop] = await db.select().from(simOrders).where(and(eq(simOrders.parentOrderId, order.id), eq(simOrders.kind, 'STOP_MARKET')));
  return {
    status: 'FILLED',
    orderId: order.id,
    clientOrderId,
    fill: { fillId: fill!.id, contracts: fill!.contracts, price: fill!.price, fee: fill!.fee, filledAt: fill!.filledAt },
    stop: { orderId: stop!.id, clientOrderId: stop!.clientOrderId, triggerPrice: stop!.triggerPrice!, basis: stop!.triggerBasis!, contracts: stop!.contracts, reduceOnly: stop!.reduceOnly }
  };
}

/** EXE-04 reconciliation: what does the venue know about this client order ID? */
export const lookupOrder = (db: Db, clientOrderId: string) => resultFor(db, clientOrderId);

export async function placeOpeningOrderWithStop(db: Db, r: OpeningRequest): Promise<SimResult> {
  const existing = await resultFor(db, r.clientOrderId);
  if (existing) return existing;

  return db.transaction(async (tx) => {
    const reject = async (reason: string): Promise<SimResult> => {
      const [o] = await tx
        .insert(simOrders)
        .values({ paperAccountId: r.paperAccountId, clientOrderId: r.clientOrderId, instrumentId: r.instrumentId, kind: 'MARKET_OPEN', side: r.side, contracts: r.contracts, status: 'REJECTED', rejectReason: reason })
        .onConflictDoNothing({ target: simOrders.clientOrderId })
        .returning({ id: simOrders.id });
      return o ? { status: 'REJECTED', orderId: o.id, clientOrderId: r.clientOrderId, reason } : (await resultFor(db, r.clientOrderId))!;
    };

    const contracts = new Decimal(r.contracts);
    if (!r.stop) return reject('STOP_REQUIRED');
    if (contracts.lt(r.contract.minQty) || !contracts.mod(r.contract.qtyStep).isZero()) return reject('INVALID_QUANTITY');
    const price = new Decimal(r.side === 'LONG' ? r.quote.ask : r.quote.bid);
    const stop = new Decimal(r.stop.price);
    if (r.side === 'LONG' ? stop.gte(price) : stop.lte(price)) return reject('STOP_WRONG_SIDE');

    const [order] = await tx
      .insert(simOrders)
      .values({ paperAccountId: r.paperAccountId, clientOrderId: r.clientOrderId, instrumentId: r.instrumentId, kind: 'MARKET_OPEN', side: r.side, contracts: r.contracts, status: 'FILLED' })
      .onConflictDoNothing({ target: simOrders.clientOrderId })
      .returning({ id: simOrders.id });
    if (!order) return (await resultFor(db, r.clientOrderId))!; // a concurrent submission won

    const notional = contracts.times(r.contract.multiplier).times(price);
    const fee = notional.times(r.contract.takerFeeRate).toDecimalPlaces(8, Decimal.ROUND_UP);
    const fillId = `simfill_${randomUUID()}`;
    await tx.insert(simFills).values({ id: fillId, orderId: order.id, paperAccountId: r.paperAccountId, contracts: contracts.toFixed(), price: price.toFixed(), fee: fee.toFixed(), filledAt: r.now });
    await addToVenuePosition(tx, r.paperAccountId, r.instrumentId, r.side, contracts.toFixed());
    // The stop rests on the venue, reduce-only, opposite side, covering the filled quantity.
    const [stopOrder] = await tx
      .insert(simOrders)
      .values({
        paperAccountId: r.paperAccountId,
        clientOrderId: stopClientId(r.clientOrderId),
        instrumentId: r.instrumentId,
        kind: 'STOP_MARKET',
        side: r.side === 'LONG' ? 'SHORT' : 'LONG',
        contracts: contracts.toFixed(),
        status: 'ACTIVE',
        reduceOnly: true,
        triggerPrice: stop.toFixed(),
        triggerBasis: r.stop.basis,
        parentOrderId: order.id
      })
      .returning({ id: simOrders.id });
    return {
      status: 'FILLED',
      orderId: order.id,
      clientOrderId: r.clientOrderId,
      fill: { fillId, contracts: contracts.toFixed(), price: price.toFixed(), fee: fee.toFixed(), filledAt: r.now },
      stop: { orderId: stopOrder!.id, clientOrderId: stopClientId(r.clientOrderId), triggerPrice: stop.toFixed(), basis: r.stop.basis, contracts: contracts.toFixed(), reduceOnly: true }
    };
  });
}

/** EXE-03: read back the venue's resting stop for verification against the filled exposure. */
export async function inspectProtection(db: Db, stopOrderId: string) {
  const [s] = await db.select().from(simOrders).where(eq(simOrders.id, stopOrderId));
  return s ? { status: s.status, side: s.side, contracts: s.contracts, triggerPrice: s.triggerPrice, basis: s.triggerBasis, reduceOnly: s.reduceOnly } : null;
}

/* ───────────────────────── Exits (venue side) ───────────────────────── */

export interface VenueQuote {
  bid: string;
  ask: string;
  mark: string;
  last: string;
  liquidityContracts?: string | null;
}

export type CloseResult =
  | { status: 'FILLED' | 'PARTIAL'; orderId: string; clientOrderId: string; requested: string; fill: SimFill }
  | { status: 'REJECTED'; orderId: string; clientOrderId: string; reason: string };

async function closeResultFor(db: Db, clientOrderId: string): Promise<CloseResult | null> {
  const [order] = await db.select().from(simOrders).where(and(eq(simOrders.clientOrderId, clientOrderId), eq(simOrders.kind, 'MARKET_CLOSE')));
  if (!order) return null;
  if (order.status === 'REJECTED') return { status: 'REJECTED', orderId: order.id, clientOrderId, reason: order.rejectReason ?? 'REJECTED' };
  const [fill] = await db.select().from(simFills).where(eq(simFills.orderId, order.id));
  return {
    status: order.status === 'FILLED' ? 'FILLED' : 'PARTIAL',
    orderId: order.id,
    clientOrderId,
    requested: order.contracts,
    fill: { fillId: fill!.id, contracts: fill!.contracts, price: fill!.price, fee: fill!.fee, filledAt: fill!.filledAt }
  };
}

/** EXE-04 reconciliation for closes. */
export const lookupCloseOrder = (db: Db, clientOrderId: string) => closeResultFor(db, clientOrderId);

/** Records the venue position change for the opening fill (called inside the opening transaction). */
async function addToVenuePosition(tx: Executor, accountId: string, instrumentId: string, side: string, contracts: string) {
  await tx
    .insert(simPositions)
    .values({ paperAccountId: accountId, instrumentId, side, contracts })
    .onConflictDoUpdate({
      target: [simPositions.paperAccountId, simPositions.instrumentId],
      set: { side, contracts: sql`${simPositions.contracts} + ${contracts}::numeric`, updatedAt: sql`now()` }
    });
}

/**
 * Reduce-only market close (EXT-02/05/06). Fills at most the venue's current position on that
 * side — so a close can never flip exposure — and at most the fixture liquidity; any unfilled
 * remainder expires (IOC). Idempotent by client order ID.
 */
export async function placeReduceOnlyClose(
  db: Db,
  r: { paperAccountId: string; clientOrderId: string; instrumentId: string; positionSide: 'LONG' | 'SHORT'; contracts: string; contract: { multiplier: string; qtyStep: string; takerFeeRate: string }; quote: VenueQuote; now: Date }
): Promise<CloseResult> {
  const existing = await closeResultFor(db, r.clientOrderId);
  if (existing) return existing;
  return db.transaction(async (tx) => {
    const closeSide = r.positionSide === 'LONG' ? 'SHORT' : 'LONG';
    const [venue] = await tx.select().from(simPositions).where(and(eq(simPositions.paperAccountId, r.paperAccountId), eq(simPositions.instrumentId, r.instrumentId))).for('update');
    const venueQty = venue && venue.side === r.positionSide ? new Decimal(venue.contracts) : new Decimal(0);
    let fillQty = Decimal.min(r.contracts, venueQty);
    if (r.quote.liquidityContracts) fillQty = Decimal.min(fillQty, r.quote.liquidityContracts);
    fillQty = fillQty.div(r.contract.qtyStep).floor().times(r.contract.qtyStep);
    const reject = async (reason: string): Promise<CloseResult> => {
      const [o] = await tx
        .insert(simOrders)
        .values({ paperAccountId: r.paperAccountId, clientOrderId: r.clientOrderId, instrumentId: r.instrumentId, kind: 'MARKET_CLOSE', side: closeSide, contracts: r.contracts, status: 'REJECTED', reduceOnly: true, rejectReason: reason })
        .onConflictDoNothing({ target: simOrders.clientOrderId })
        .returning({ id: simOrders.id });
      return o ? { status: 'REJECTED', orderId: o.id, clientOrderId: r.clientOrderId, reason } : (await closeResultFor(db, r.clientOrderId))!;
    };
    if (venueQty.isZero()) return reject('REDUCE_ONLY_NO_POSITION');
    if (fillQty.lte(0)) return reject('NO_LIQUIDITY');

    const full = fillQty.eq(r.contracts);
    const [order] = await tx
      .insert(simOrders)
      .values({ paperAccountId: r.paperAccountId, clientOrderId: r.clientOrderId, instrumentId: r.instrumentId, kind: 'MARKET_CLOSE', side: closeSide, contracts: r.contracts, status: full ? 'FILLED' : 'PARTIAL_EXPIRED', reduceOnly: true })
      .onConflictDoNothing({ target: simOrders.clientOrderId })
      .returning({ id: simOrders.id });
    if (!order) return (await closeResultFor(db, r.clientOrderId))!;
    // Closing a Long sells at the bid; closing a Short buys at the ask.
    const price = new Decimal(r.positionSide === 'LONG' ? r.quote.bid : r.quote.ask);
    const fee = fillQty.times(r.contract.multiplier).times(price).times(r.contract.takerFeeRate).toDecimalPlaces(8, Decimal.ROUND_UP);
    const fillId = `simfill_${randomUUID()}`;
    await tx.insert(simFills).values({ id: fillId, orderId: order.id, paperAccountId: r.paperAccountId, contracts: fillQty.toFixed(), price: price.toFixed(), fee: fee.toFixed(), filledAt: r.now });
    await tx
      .update(simPositions)
      .set({ contracts: sql`${simPositions.contracts} - ${fillQty.toFixed()}::numeric`, updatedAt: sql`now()` })
      .where(and(eq(simPositions.paperAccountId, r.paperAccountId), eq(simPositions.instrumentId, r.instrumentId)));
    return { status: full ? 'FILLED' : 'PARTIAL', orderId: order.id, clientOrderId: r.clientOrderId, requested: r.contracts, fill: { fillId, contracts: fillQty.toFixed(), price: price.toFixed(), fee: fee.toFixed(), filledAt: r.now } };
  });
}

export interface StopFill extends SimFill {
  stopOrderId: string;
  stopClientOrderId: string;
  paperAccountId: string;
}

/**
 * EXT-01: the venue triggers resting stops whose trigger price is reached on their own basis
 * (MARK or LAST). A stop fills reduce-only at market for at most the venue position.
 */
export async function triggerStops(db: Db, instrumentId: string, quote: VenueQuote, now: Date): Promise<StopFill[]> {
  const active = await db.select().from(simOrders).where(and(eq(simOrders.instrumentId, instrumentId), eq(simOrders.kind, 'STOP_MARKET'), eq(simOrders.status, 'ACTIVE')));
  const out: StopFill[] = [];
  for (const s of active) {
    const p = new Decimal(s.triggerBasis === 'LAST' ? quote.last : quote.mark);
    // A SHORT stop protects a Long (sells when price falls); a LONG stop protects a Short.
    const hit = s.side === 'SHORT' ? p.lte(s.triggerPrice!) : p.gte(s.triggerPrice!);
    if (!hit) continue;
    const fill = await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(simOrders).where(eq(simOrders.id, s.id)).for('update');
      if (cur!.status !== 'ACTIVE') return null;
      const positionSide = s.side === 'SHORT' ? 'LONG' : 'SHORT';
      const [venue] = await tx.select().from(simPositions).where(and(eq(simPositions.paperAccountId, s.paperAccountId), eq(simPositions.instrumentId, instrumentId))).for('update');
      const venueQty = venue && venue.side === positionSide ? new Decimal(venue.contracts) : new Decimal(0);
      const qty = Decimal.min(cur!.contracts, venueQty);
      if (qty.lte(0)) {
        await tx.update(simOrders).set({ status: 'CANCELLED', rejectReason: 'NO_POSITION' }).where(eq(simOrders.id, s.id));
        return null;
      }
      const price = new Decimal(s.side === 'SHORT' ? quote.bid : quote.ask);
      const [inst] = await tx.select({ m: instruments.contractMultiplier, fee: instruments.takerFeeRate }).from(instruments).where(eq(instruments.id, instrumentId));
      const fee = qty.times(inst!.m).times(price).times(inst!.fee).toDecimalPlaces(8, Decimal.ROUND_UP);
      const fillId = `simfill_${randomUUID()}`;
      await tx.update(simOrders).set({ status: 'TRIGGERED' }).where(eq(simOrders.id, s.id));
      await tx.insert(simFills).values({ id: fillId, orderId: s.id, paperAccountId: s.paperAccountId, contracts: qty.toFixed(), price: price.toFixed(), fee: fee.toFixed(), filledAt: now });
      await tx
        .update(simPositions)
        .set({ contracts: sql`${simPositions.contracts} - ${qty.toFixed()}::numeric`, updatedAt: sql`now()` })
        .where(and(eq(simPositions.paperAccountId, s.paperAccountId), eq(simPositions.instrumentId, instrumentId)));
      return { fillId, contracts: qty.toFixed(), price: price.toFixed(), fee: fee.toFixed(), filledAt: now, stopOrderId: s.id, stopClientOrderId: s.clientOrderId, paperAccountId: s.paperAccountId };
    });
    if (fill) out.push(fill);
  }
  return out;
}

/** Venue stop fills on an instrument (for platform reconciliation after any crash). */
export async function listStopFills(db: Db, instrumentId: string): Promise<StopFill[]> {
  const rows = await db
    .select({ f: simFills, o: simOrders })
    .from(simFills)
    .innerJoin(simOrders, eq(simOrders.id, simFills.orderId))
    .where(and(eq(simOrders.instrumentId, instrumentId), eq(simOrders.kind, 'STOP_MARKET')));
  return rows.map(({ f, o }) => ({ fillId: f.id, contracts: f.contracts, price: f.price, fee: f.fee, filledAt: f.filledAt, stopOrderId: o.id, stopClientOrderId: o.clientOrderId, paperAccountId: o.paperAccountId }));
}

/** EXE-03: resize the resting stop to the remaining exposure (never widens the trigger). */
export async function resizeProtection(db: Db, stopOrderId: string, contracts: string): Promise<void> {
  await db.update(simOrders).set({ contracts }).where(and(eq(simOrders.id, stopOrderId), eq(simOrders.status, 'ACTIVE')));
}

export async function cancelOrder(db: Db, orderId: string): Promise<void> {
  await db.update(simOrders).set({ status: 'CANCELLED' }).where(and(eq(simOrders.id, orderId), eq(simOrders.status, 'ACTIVE')));
}

/** Venue position for verification ("confirm zero quantity before clearing the stop"). */
export async function venuePosition(db: Db | Executor, paperAccountId: string, instrumentId: string): Promise<{ side: string | null; contracts: string }> {
  const [v] = await db.select().from(simPositions).where(and(eq(simPositions.paperAccountId, paperAccountId), eq(simPositions.instrumentId, instrumentId)));
  return { side: v?.side ?? null, contracts: v ? new Decimal(v.contracts).toFixed() : '0' };
}
