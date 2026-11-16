import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { Decimal, type ExitReason } from '@trendpilot/domain';
import type { Db } from '../client';
import { recordExitFill } from '../paper/exits';
import { exchangeAccountEvents, exchangePositions, fills, instruments, orderIntents, paperAccounts, positionExits, positions } from '../schema';
import { readHistoryTrades, type BitunixTrade } from './bitunixAccount';
import { bitunixVenue } from './bitunixOrders';
import { BitunixPrivateError, type BitunixRequester } from './bitunixPrivate';
import type { ConnectionRow } from './liveMode';
import { INFLIGHT_CLOSE_GRACE_MS } from './liveSync';

/**
 * Links the Step 2 Bitunix position mirror to TrendPilot's Live positions (Step 4), by exchange
 * connection and Bitunix positionId. When Bitunix holds less of a leg than TrendPilot (a manual
 * close on Bitunix, a partial close, the exchange stop executing, a liquidation), the difference is
 * booked from Bitunix's own fills for that position:
 *  - each closing Bitunix order becomes one exit fill keyed `bitunix:<orderId>` — the same key
 *    TrendPilot's own close orders use, so a close is booked exactly once whichever path sees it;
 *  - a FULL close is recorded only when the mirror says CLOSED, which itself needs Bitunix's
 *    position history (a tpsl trigger, a missing row or a CLOSE push never closes anything);
 *  - fills not listed yet leave the difference pending; nothing is estimated.
 * After a partial close the remaining quantity's protection is resized/verified through the
 * Bitunix venue (read-only here): a whole-leg TP/SL follows the leg; a fixed-quantity TP/SL cannot
 * be modified in this release and leaves the position UNPROTECTED (existing recovery policy).
 */

export interface BitunixPositionLink {
  positionId: string;
  exchangePositionId: string;
  symbol: string;
  side: string;
  result: 'IN_SYNC' | 'PARTIAL' | 'FULL' | 'FILLS_PENDING' | 'SKIPPED';
  booked: { fillId: string; contracts: string; reason: ExitReason }[];
  pendingContracts?: string;
  protection?: { kind: 'WHOLE_LEG' | 'FIXED_QTY' | 'NONE'; status: string; stopContracts: string | null; note?: string };
  reason?: string;
}

const D = (v: Decimal.Value) => new Decimal(v);

/** Read-only Bitunix venue for position reads and protection checks (any order call is refused). */
function readOnlyVenue(db: Db, r: BitunixRequester) {
  return bitunixVenue({
    requester: {
      get: (path, params) => r.get(path, params),
      post: async () => {
        throw new BitunixPrivateError('the reconciliation path never places orders', 'REFUSED');
      }
    },
    contractFor: async (instrumentId) => {
      const [i] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
      if (!i) throw new Error(`instrument ${instrumentId} not found`);
      return { symbol: i.exchangeSymbol, qtyStep: i.qtyStep, minQty: i.minQty, maxQty: i.maxQty, priceTick: i.priceTick, takerFeeRate: i.takerFeeRate };
    },
    confirm: { attempts: 1, delayMs: 0 }
  });
}

/**
 * Closed Bitunix positions whose history was confirmed after TrendPilot closed them: the position's
 * funding total and settled figures as Bitunix's history reports them (once, idempotently).
 */
async function backfillClosedFacts(db: Db, conn: ConnectionRow, now: Date): Promise<void> {
  const rows = await db
    .select({ id: positions.id, fundingNow: positions.exchangeFundingUsdt, m: exchangePositions })
    .from(positions)
    .innerJoin(paperAccounts, eq(paperAccounts.id, positions.paperAccountId))
    .innerJoin(exchangePositions, and(eq(exchangePositions.connectionId, conn.id), eq(exchangePositions.exchangePositionId, positions.exchangePositionRef)))
    .where(and(eq(positions.ownerId, conn.ownerId), eq(positions.mode, 'LIVE'), eq(positions.status, 'CLOSED'), eq(paperAccounts.exchange, 'BITUNIX'), eq(exchangePositions.status, 'CLOSED'), isNull(positions.exchangeSyncedAt)));
  for (const r of rows) {
    await db
      .update(positions)
      .set({ exchangeFundingUsdt: r.m.settledFunding ?? r.m.reportedFunding, exchangeContracts: '0', exchangeLiquidationPrice: null, exchangeSyncedAt: now, updatedAt: sql`now()` })
      .where(eq(positions.id, r.id));
  }
}

interface OrderGroup {
  orderId: string;
  clientId: string | null;
  qty: Decimal;
  notional: Decimal;
  fee: Decimal;
  feeKnown: boolean;
  realized: Decimal;
  reduceOnly: boolean;
  at: number;
}

function groupByOrder(trades: BitunixTrade[]): OrderGroup[] {
  const m = new Map<string, OrderGroup>();
  const seen = new Set<string>();
  for (const t of trades) {
    // Each trade counts once, even if a caller passes overlapping reads.
    if (seen.has(t.tradeId)) continue;
    seen.add(t.tradeId);
    const g = m.get(t.orderId) ?? { orderId: t.orderId, clientId: t.clientId, qty: D(0), notional: D(0), fee: D(0), feeKnown: true, realized: D(0), reduceOnly: false, at: 0 };
    if (t.reduceOnly) g.reduceOnly = true;
    g.qty = g.qty.plus(t.qty);
    g.notional = g.notional.plus(D(t.qty).times(t.price));
    if (t.fee === null) g.feeKnown = false;
    else g.fee = g.fee.plus(t.fee);
    g.realized = g.realized.plus(t.realizedPNL ?? 0);
    g.at = Math.max(g.at, t.ctimeMs ?? 0);
    m.set(t.orderId, g);
  }
  return [...m.values()].sort((a, b) => a.at - b.at || a.orderId.localeCompare(b.orderId));
}

export async function linkBitunixPositions(db: Db, conn: ConnectionRow, r: BitunixRequester, now: Date): Promise<BitunixPositionLink[]> {
  const out: BitunixPositionLink[] = [];
  await backfillClosedFacts(db, conn, now);
  const open = await db
    .select({ p: positions })
    .from(positions)
    .innerJoin(paperAccounts, eq(paperAccounts.id, positions.paperAccountId))
    .where(and(eq(positions.ownerId, conn.ownerId), eq(positions.mode, 'LIVE'), eq(positions.status, 'OPEN'), eq(paperAccounts.exchange, 'BITUNIX'), isNotNull(positions.exchangePositionRef)));
  if (!open.length) return out;
  const venue = readOnlyVenue(db, r);
  const tpsl = ((conn.accountState as { tpsl?: { positionId: string | null; slPrice: string | null; slQty: string | null }[] } | null)?.tpsl ?? []).filter((t) => t.slPrice !== null);

  for (const { p } of open) {
    const ref = p.exchangePositionRef!;
    const base = { positionId: p.id, exchangePositionId: ref, symbol: '', side: p.side, booked: [] as BitunixPositionLink['booked'] };
    const [inst] = await db.select({ symbol: instruments.exchangeSymbol }).from(instruments).where(eq(instruments.id, p.instrumentId));
    base.symbol = inst?.symbol ?? '';
    // A TrendPilot order on this contract still in flight (fresh): its own job confirms it.
    const [busy] = await db
      .select({ id: orderIntents.id, kind: orderIntents.kind, at: orderIntents.submittedAt, created: orderIntents.createdAt })
      .from(orderIntents)
      .where(and(eq(orderIntents.paperAccountId, p.paperAccountId), eq(orderIntents.instrumentId, p.instrumentId), inArray(orderIntents.state, ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'])));
    if (busy && (busy.kind !== 'CLOSE' || now.getTime() - (busy.at ?? busy.created).getTime() < INFLIGHT_CLOSE_GRACE_MS)) {
      out.push({ ...base, result: 'SKIPPED', reason: `${busy.kind} order in flight` });
      continue;
    }
    const [mirror] = await db.select().from(exchangePositions).where(and(eq(exchangePositions.connectionId, conn.id), eq(exchangePositions.exchangePositionId, ref)));
    if (!mirror || mirror.status === 'DETACHED') {
      out.push({ ...base, result: 'SKIPPED', reason: mirror ? 'mirror detached (key replaced)' : 'not in the Bitunix mirror yet' });
      continue;
    }
    // Bitunix's own figures for this leg, shown in Holdings and trade details as reported: estimated
    // liquidation price, the running funding total (no per-settlement records exist), current size.
    await db
      .update(positions)
      .set({
        exchangeLiquidationPrice: mirror.status === 'OPEN' ? mirror.liqPrice : null,
        exchangeFundingUsdt: mirror.status === 'CLOSED' ? (mirror.settledFunding ?? mirror.reportedFunding) : mirror.reportedFunding,
        exchangeContracts: mirror.status === 'OPEN' ? mirror.qty : '0',
        exchangeSyncedAt: now,
        updatedAt: sql`now()`
      })
      .where(eq(positions.id, p.id));
    // Bitunix's size for this leg: CLOSED only once history confirmed it; a pending close check keeps the last size.
    const venueQty = mirror.status === 'CLOSED' ? D(0) : D(mirror.qty);
    let platformQty = D(p.contracts);
    if (!venueQty.lt(platformQty)) {
      out.push({ ...base, result: 'IN_SYNC' });
      continue;
    }

    // Closing orders for this position on Bitunix, excluding the orders that OPENED TrendPilot positions.
    const trades = (await readHistoryTrades(r, { positionId: ref, startTime: p.openedAt.getTime() - 60_000 }, { maxPages: 10 })).items;
    const opening = new Set((await db.select({ id: fills.exchangeFillId }).from(fills).where(eq(fills.paperAccountId, p.paperAccountId))).map((f) => f.id));
    const booked = new Set((await db.select({ id: positionExits.exchangeFillId }).from(positionExits).where(eq(positionExits.positionId, p.id))).map((f) => f.id));
    // A close realizes P&L (or is reduce-only); an opening/adding order does not. Bitunix's documented
    // sides cannot tell them apart in Hedge mode (close long and open long are both BUY).
    const groups = groupByOrder(trades).filter((g) => !opening.has(`bitunix:${g.orderId}`) && (!g.realized.isZero() || g.reduceOnly));
    const stopEvents = await db
      .select({ at: exchangeAccountEvents.businessTime })
      .from(exchangeAccountEvents)
      .where(and(eq(exchangeAccountEvents.connectionId, conn.id), eq(exchangeAccountEvents.exchangePositionId, ref), inArray(exchangeAccountEvents.kind, ['TPSL_TRIGGERED', 'TPSL_EXECUTED'])));
    const liquidated = mirror.status === 'CLOSED' && (await db.select({ d: exchangeAccountEvents.detail }).from(exchangeAccountEvents).where(and(eq(exchangeAccountEvents.connectionId, conn.id), eq(exchangeAccountEvents.dedupKey, `close:${ref}`)))).some((e) => (e.d as { liquidated?: boolean }).liquidated);

    let cur = p;
    for (const g of groups) {
      const fillId = `bitunix:${g.orderId}`;
      if (booked.has(fillId)) continue;
      const need = platformQty.minus(venueQty);
      if (need.lte(0)) break;
      const qty = Decimal.min(g.qty, need);
      // TrendPilot's own close (clientId tp-…): booked by its own job under this same key; the
      // original exit reason is used if the sync gets there first.
      const own = g.clientId && /^tpx?-/.test(g.clientId) ? (await db.select({ reason: orderIntents.exitReason, id: orderIntents.id }).from(orderIntents).where(eq(orderIntents.clientOrderId, g.clientId)))[0] : undefined;
      const stopTriggered = stopEvents.some((e) => e.at && e.at.getTime() <= g.at + 1_000);
      const reason: ExitReason = own?.reason ? (own.reason as ExitReason) : liquidated ? 'LIQUIDATION' : stopTriggered ? 'STOP_LOSS' : 'EXTERNAL_CLOSE';
      const flatNow = mirror.status === 'CLOSED' && platformQty.minus(qty).lte(venueQty);
      const res = await db.transaction(async (tx) => {
        const [locked] = await tx.select().from(positions).where(eq(positions.id, cur.id)).for('update');
        if (!locked || locked.status !== 'OPEN') return null;
        return recordExitFill(db, tx, {
          position: locked,
          fill: { fillId, contracts: qty.toFixed(), price: g.notional.div(g.qty).toDecimalPlaces(12).toFixed(), fee: g.feeKnown ? g.fee.toDecimalPlaces(8).toFixed() : '0', filledAt: new Date(g.at || now.getTime()), realizedPnl: g.realized.isZero() ? null : g.realized.toFixed() },
          reason,
          intentId: own?.id ?? null,
          now,
          venue,
          venueConfirmedFlat: flatNow
        });
      });
      if (!res) break;
      if (res.recorded) base.booked.push({ fillId, contracts: qty.toFixed(), reason });
      platformQty = D(res.remaining);
      const [fresh] = await db.select().from(positions).where(eq(positions.id, cur.id));
      cur = fresh!;
      if (cur.status !== 'OPEN') break;
    }

    // History confirmed the close but some of it has no listed fill: book the remainder at Bitunix's
    // close price (the fee for it is not reported: booked as 0 with that noted).
    if (cur.status === 'OPEN' && mirror.status === 'CLOSED' && platformQty.gt(0) && mirror.closePrice) {
      const reason: ExitReason = liquidated ? 'LIQUIDATION' : stopEvents.length ? 'STOP_LOSS' : 'EXTERNAL_CLOSE';
      const res = await db.transaction(async (tx) => {
        const [locked] = await tx.select().from(positions).where(eq(positions.id, cur.id)).for('update');
        if (!locked || locked.status !== 'OPEN') return null;
        return recordExitFill(db, tx, {
          position: locked,
          fill: { fillId: `bitunix-close:${ref}`, contracts: platformQty.toFixed(), price: mirror.closePrice!, fee: '0', filledAt: mirror.closedAt ?? now, realizedPnl: null },
          reason,
          intentId: null,
          now,
          venue,
          venueConfirmedFlat: true
        });
      });
      if (res?.recorded) base.booked.push({ fillId: `bitunix-close:${ref}`, contracts: platformQty.toFixed(), reason });
      if (res) platformQty = D(res.remaining);
      const [fresh] = await db.select().from(positions).where(eq(positions.id, cur.id));
      cur = fresh!;
    }

    const t = tpsl.find((x) => x.positionId === ref);
    const protection =
      cur.status === 'OPEN'
        ? {
            kind: (t ? (t.slQty === null ? 'WHOLE_LEG' : 'FIXED_QTY') : 'NONE') as 'WHOLE_LEG' | 'FIXED_QTY' | 'NONE',
            status: cur.protectionStatus,
            stopContracts: cur.stopContracts,
            ...(t && t.slQty !== null && cur.protectionStatus !== 'PROTECTED' ? { note: 'Fixed-quantity Bitunix TP/SL: resizing it is an order-changing call this release does not make; the existing recovery policy applies.' } : {})
          }
        : undefined;
    const pending = platformQty.minus(venueQty);
    out.push({
      ...base,
      result: cur.status === 'CLOSED' ? 'FULL' : pending.gt(0) ? 'FILLS_PENDING' : 'PARTIAL',
      ...(pending.gt(0) && cur.status === 'OPEN' ? { pendingContracts: pending.toFixed() } : {}),
      ...(protection ? { protection } : {})
    });
  }
  return out;
}
