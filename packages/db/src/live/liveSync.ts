import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { Decimal, realizedPnl, type ExitReason } from '@trendpilot/domain';

type PositionRow = typeof positions.$inferSelect;
import type { Db } from '../client';
import { exchangeConnections, fills, instruments, orderBlocks, orderIntents, paperAccounts, positionExits, positions, positionTargets } from '../schema';

import { book, lockPaperAccount } from '../paper/accounts';
import { recordExitFill } from '../paper/exits';
import type { ExecutionVenue } from '../venue/types';
import { applyExchangeBalance, connectionFor, haltConnectionEntries, LiveVenueUnavailable, type ConnectionRow } from './liveMode';
import {
  MexcHttpTransport,
  MexcPrivateError,
  MEXC_PRIVATE_DEFAULT_BASE_URL,
  normalizeAssets,
  normalizeOrder,
  normalizePositions,
  normalizeStops,
  type MexcRequester,
  type NormalizedOrder,
  type NormalizedPosition,
  type NormalizedStop
} from './mexcPrivate';
import { open as unseal } from '../security/secretBox';
import { mexcVenue } from './mexcVenue';

/**
 * Private MEXC sync for one Live account (REP-01, OPS-03). Runs in the worker on a schedule, and
 * on demand from Admin → Live and from the investor's "Sync with MEXC" button (same code). Every
 * MEXC call here is a read; reconciliation never sends, replaces or cancels an order. Per run:
 *  1. Balance: the Live wallet follows MEXC's cash balance (equity − unrealized) through an
 *     EXCHANGE_BALANCE_SYNC ledger row; equity and available-to-open are stored for display and
 *     for the entry margin check. Applied again after exits are booked, so wallet, margin and
 *     available agree with MEXC at the end of the run.
 *  2. Positions, for every open Live position whose contract has no order in flight:
 *     - smaller (or gone) at MEXC → a close made on MEXC (or a stop MEXC triggered). The closing
 *       fills in MEXC's deal history are booked once each (unique fill ID `mexc:<orderId>`) with
 *       MEXC's price, time, fee and realized P&L. An order is booked only when MEXC reports it
 *       final with all its deals listed; an order belonging to a TrendPilot close still in flight
 *       is left to that order's own job. Fills not listed yet leave the position open with
 *       FILLS_PENDING ("MEXC confirms closed, fill details pending").
 *     - same size → store positionId, liquidation price and funding, and verify the stop covers
 *       the whole quantity. A stop that no longer covers it is shown (UNPROTECTED + STOP_MISSING
 *       drift, entries halted); nothing is sent.
 *     Positions are matched by MEXC position ID once it is known: a new MEXC position on the same
 *     symbol and side is never taken for the old one (the old one is treated as closed on MEXC and
 *     the new one is reported as exposure TrendPilot did not open).
 *     - anything still different (or exposure TrendPilot does not know on a traded contract) →
 *       drift recorded and new entries halted until an operator reviews it.
 *  A failed MEXC query aborts the run before the affected position is touched: it stays as it
 *  was (unconfirmed) and the error is stored on the connection. Runs for one account are
 *  serialised by a lease; ledger rows and exits are unique per fill, so a repeated run books
 *  nothing twice. Drift is replaced by what this run found (cleared once the records agree);
 *  halts are never lifted here — an operator resumes. Reconciliation never replays a
 *  signal and never queues an entry; a reversal overtaken by a manual close stays withheld
 *  (paper.reverse: REVERSAL_CLOSED_ON_EXCHANGE).
 */

const D = (v: Decimal.Value) => new Decimal(v);
const UNRESOLVED = ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'] as const;
/** A TrendPilot close younger than this is still being confirmed by its own job: not reconciled yet. */
export const INFLIGHT_CLOSE_GRACE_MS = 120_000;
const DEAL_PAGE_SIZE = 100;
const DEAL_MAX_PAGES = 20;
/** A run holds its account's lease at most this long (a crashed run frees it on expiry). */
const SYNC_LEASE_SECONDS = 120;
export const SYNC_BUSY = 'A sync for this account is already running; try again in a moment.';

export interface DriftItem {
  kind: 'SIZE_MISMATCH' | 'UNKNOWN_EXPOSURE' | 'SIDE_MISMATCH' | 'STOP_MISSING' | 'STOP_ORPHANED';
  symbol: string;
  detail: string;
  at: string;
}

/** Reads the USDT balance from MEXC (read-only) and applies it to the Live account now. */
export async function refreshLiveBalance(db: Db, ownerId: string, now: Date, env: Record<string, string | undefined> = process.env): Promise<{ equity: string; available: string }> {
  const conn = await connectionFor(db, ownerId);
  if (!conn || conn.status === 'REVOKED' || !conn.apiKeySealed) throw new Error('no exchange connection');
  const usdt = normalizeAssets(await readRequester(conn, env).request('GET', '/api/v1/private/account/assets')).find((a) => a.currency === 'USDT');
  if (!usdt) throw new Error('MEXC returned no USDT balance');
  await applyExchangeBalance(db, ownerId, usdt, `refresh:${conn.id}:${now.toISOString()}`, now);
  return { equity: usdt.equity, available: usdt.availableOpen };
}

/** What a run did to one position after a close made on MEXC. */
export interface ExchangeCloseOutcome {
  positionId: string;
  symbol: string;
  /**
   * FULL: moved to Closed with its fills. FULL_FILLS_PENDING: MEXC holds none of it, moved to Closed,
   * fill details pending. FILLS_BACKFILLED: the pending fills were booked. PARTIAL: remainder
   * updated. FILLS_PENDING: MEXC confirms a partial close, fills not listed yet.
   */
  result: 'FULL' | 'FULL_FILLS_PENDING' | 'FILLS_BACKFILLED' | 'PARTIAL' | 'FILLS_PENDING';
  /** Contracts closed on MEXC whose fills are not booked yet. */
  pendingContracts?: string;
  platformContracts: string;
  exchangeContracts: string;
  /** PARTIAL / FILLS_PENDING with a remainder: does the active MEXC stop cover it? */
  stopCoverage?: 'FULL' | 'PARTIAL' | 'NONE';
  stopContracts?: string | null;
}

export interface LiveSyncSummary {
  ownerId: string;
  ok: boolean;
  error?: string;
  balance?: { equity: string; available: string; walletAdjustment: string };
  positionsChecked: number;
  exitsRecorded: number;
  protectionFailures: number;
  drift: DriftItem[];
  closes: ExchangeCloseOutcome[];
  /** Positions not reconciled this run because an order for the contract is still in flight. */
  skipped: { positionId: string; symbol: string; reason: string }[];
  /** Another run for this account held the lease: nothing was read or changed. */
  busy?: boolean;
}

/* Test seam: reads through the same mocked exchange the Live venue uses. */
let readSeam: ((conn: ConnectionRow) => MexcRequester) | null = null;
export function installLiveSyncSeam(f: ((conn: ConnectionRow) => MexcRequester) | null, env: Record<string, string | undefined> = process.env): void {
  if (f && env.NODE_ENV === 'production') throw new Error('The Live sync seam is not allowed in production.');
  readSeam = f;
}

function readRequester(conn: ConnectionRow, env: Record<string, string | undefined>): MexcRequester {
  if (readSeam) return readSeam(conn);
  return new MexcHttpTransport({ mode: 'READ_ONLY', credentials: { apiKey: unseal(conn.apiKeySealed), secretKey: unseal(conn.secretSealed) }, baseUrl: env.MEXC_PRIVATE_BASE_URL || MEXC_PRIVATE_DEFAULT_BASE_URL, env });
}

interface Deal {
  id: string;
  orderId: string;
  side: number;
  vol: string;
  price: string;
  fee: string;
  /** MEXC's realized P&L for the deal, when listed. */
  profit: string | null;
  timestamp: number;
  /** MEXC position the deal belongs to, when listed. */
  positionId: string | null;
}
const listOf = (data: unknown): unknown[] => (Array.isArray(data) ? data : ((data as { resultList?: unknown[] } | null)?.resultList ?? []));

/** Deal history (`order/list/order_deals/v3`). The docs show both a paginated wrapper and a bare array. */
export function normalizeDealHistory(data: unknown): Deal[] {
  const seen = new Map<string, Deal>();
  for (const d of listOf(data) as Record<string, unknown>[]) {
    const id = String(d.id);
    if (seen.has(id)) continue;
    const profit = d.profit === null || d.profit === undefined || d.profit === '' ? null : D(String(d.profit)).toFixed();
    // The execution time is `timestamp` in the docs; some responses carry createTime/updateTime instead.
    const ts = Number(d.timestamp ?? d.createTime ?? d.updateTime ?? 0);
    const positionId = d.positionId === null || d.positionId === undefined || Number(d.positionId) === 0 ? null : String(d.positionId);
    seen.set(id, { id, orderId: String(d.orderId ?? ''), side: Number(d.side), vol: D(String(d.vol ?? 0)).toFixed(), price: D(String(d.price ?? 0)).toFixed(), fee: D(String(d.fee ?? 0)).toFixed(), profit, timestamp: ts, positionId });
  }
  return [...seen.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}

/** Every deal since `startMs`, all pages. A history longer than the page cap is refused as incomplete. */
export async function dealHistory(read: MexcRequester, symbol: string, startMs: number): Promise<Deal[]> {
  const raw: unknown[] = [];
  for (let page = 1; page <= DEAL_MAX_PAGES; page++) {
    const rows = listOf(await read.request('GET', '/api/v1/private/order/list/order_deals/v3', { symbol, start_time: startMs, page_num: page, page_size: DEAL_PAGE_SIZE }));
    raw.push(...rows);
    if (rows.length < DEAL_PAGE_SIZE) return normalizeDealHistory(raw);
  }
  throw new Error(`${symbol}: MEXC deal history exceeds ${DEAL_PAGE_SIZE * DEAL_MAX_PAGES} records; not reconciled`);
}

/** One order by MEXC order ID; null when MEXC no longer lists it. */
export async function orderById(read: MexcRequester, orderId: string): Promise<NormalizedOrder | null> {
  try {
    const data = await read.request<Record<string, unknown> | null | undefined>('GET', `/api/v1/private/order/get/${orderId}`);
    return data ? normalizeOrder(data) : null;
  } catch (e) {
    if (e instanceof MexcPrivateError && e.kind === 'API' && e.code === 2040) return null;
    throw e;
  }
}

/** Read-only MEXC queries for one investor's connection (ops inspection). Never sends anything. */
export function mexcReadOnly(conn: ConnectionRow, env: Record<string, string | undefined> = process.env) {
  const read = readRequester(conn, env);
  return {
    assets: async () => normalizeAssets(await read.request('GET', '/api/v1/private/account/assets')),
    openPositions: async () => normalizePositions(await read.request('GET', '/api/v1/private/position/open_positions', {})),
    stops: async (symbol: string) => normalizeStops(await read.request('GET', '/api/v1/private/stoporder/open_orders', { symbol })),
    deals: (symbol: string, startMs: number) => dealHistory(read, symbol, startMs),
    order: (orderId: string) => orderById(read, orderId),
    orderByClientId: async (symbol: string, clientOrderId: string) => {
      try {
        const data = await read.request<Record<string, unknown> | null | undefined>('GET', `/api/v1/private/order/external/${symbol}/${clientOrderId}`);
        return data ? normalizeOrder(data) : null;
      } catch (e) {
        if (e instanceof MexcPrivateError && e.kind === 'API' && e.code === 2040) return null;
        throw e;
      }
    }
  };
}

/** Reconciliation venue: MEXC reads only. Anything order-changing is refused or a no-op. */
function readOnlyVenue(db: Db, read: MexcRequester, conn: ConnectionRow): ExecutionVenue {
  const v = mexcVenue({
    requester: read,
    symbolFor: async (instrumentId) => (await db.select({ s: instruments.exchangeSymbol }).from(instruments).where(eq(instruments.id, instrumentId)))[0]?.s ?? '',
    positionMode: (conn.positionMode as 'ONE_WAY' | 'HEDGE') ?? 'ONE_WAY'
  });
  const refuse = async (): Promise<never> => {
    throw new Error('Live reconciliation never sends orders.');
  };
  return { ...v, placeOpeningOrderWithStop: refuse, placeReduceOnlyClose: refuse, cancelOrder: async () => undefined, resizeProtection: async (stopOrderId) => stopOrderId };
}

/** Does this MEXC stop protect `contracts` of a `side` position? (reduce-only, active, right side) */
export const stopCoverage = (stop: NormalizedStop | undefined, side: string, contracts: Decimal.Value): 'FULL' | 'PARTIAL' | 'NONE' => {
  if (!stop || stop.state !== 'ACTIVE' || stop.reverse || stop.positionSide !== side || D(stop.vol).lte(0)) return 'NONE';
  return D(stop.vol).gte(contracts) ? 'FULL' : 'PARTIAL';
};

export async function syncLiveAccount(db: Db, ownerId: string, now: Date, opts: { env?: Record<string, string | undefined> } = {}): Promise<LiveSyncSummary> {
  const env = opts.env ?? process.env;
  const out: LiveSyncSummary = { ownerId, ok: false, positionsChecked: 0, exitsRecorded: 0, protectionFailures: 0, drift: [], closes: [], skipped: [] };
  const conn = await connectionFor(db, ownerId);
  if (!conn || conn.status === 'REVOKED' || !conn.apiKeySealed) return { ...out, error: 'no connection' };
  const at = now.toISOString();
  // One run per account at a time (worker, admin and investor button). Database time, not the signal clock.
  const [lease] = await db
    .update(exchangeConnections)
    .set({ syncLeaseUntil: sql`now() + make_interval(secs => ${SYNC_LEASE_SECONDS})` })
    .where(and(eq(exchangeConnections.id, conn.id), sql`(${exchangeConnections.syncLeaseUntil} IS NULL OR ${exchangeConnections.syncLeaseUntil} < now())`))
    .returning({ id: exchangeConnections.id });
  if (!lease) return { ...out, error: SYNC_BUSY, busy: true };
  try {
    const read = readRequester(conn, env);

    // 1. Balance.
    const usdt = normalizeAssets(await read.request('GET', '/api/v1/private/account/assets')).find((a) => a.currency === 'USDT');
    if (usdt) {
      const b = await applyExchangeBalance(db, ownerId, usdt, `sync:${conn.id}:${at}`, now);
      out.balance = { equity: usdt.equity, available: usdt.availableOpen, walletAdjustment: b.walletAdjustment };
    }
    const acct = await db.transaction((tx) => lockPaperAccount(tx, ownerId, 'LIVE'));

    // 2. Positions.
    const venuePositions = normalizePositions(await read.request('GET', '/api/v1/private/position/open_positions', {})).filter((p) => p.open && D(p.contracts).gt(0));
    const open = await db
      .select({ p: positions, symbol: instruments.exchangeSymbol })
      .from(positions)
      .innerJoin(instruments, eq(instruments.id, positions.instrumentId))
      .where(and(eq(positions.paperAccountId, acct.id), eq(positions.status, 'OPEN')));
    const busy = await db
      .select({ instrumentId: orderIntents.instrumentId, kind: orderIntents.kind, clientOrderId: orderIntents.clientOrderId, createdAt: orderIntents.createdAt, submittedAt: orderIntents.submittedAt })
      .from(orderIntents)
      .where(and(eq(orderIntents.paperAccountId, acct.id), inArray(orderIntents.state, [...UNRESOLVED])));
    const inFlight = new Set(busy.map((b) => b.instrumentId));
    const stopsBySymbol = new Map<string, NormalizedStop[]>();
    const stopsFor = async (symbol: string) => {
      if (!stopsBySymbol.has(symbol)) stopsBySymbol.set(symbol, normalizeStops(await read.request('GET', '/api/v1/private/stoporder/open_orders', { symbol })));
      return stopsBySymbol.get(symbol)!;
    };
    let venue: ExecutionVenue | null = null;
    let balanceDirty = false;

    /**
     * Closing orders of position `p` that MEXC reports final with every deal listed (or, when MEXC no
     * longer lists the order, whose listed deals cover `gap`), not booked yet, not belonging to a
     * TrendPilot order still in flight, and not belonging to another MEXC position.
     */
    const completeCloses = async (p: PositionRow, symbol: string, gap: Decimal) => {
      const since = p.openedAt.getTime() - 60_000;
      const deals = await dealHistory(read, symbol, since);
      // Close side (4 close long / 2 close short). In One-way mode a manual Sell/Buy that reduces the
      // position can be recorded with the open side of the other direction (3 / 1): accepted only when
      // MEXC ties the deal or its order to this position's ID.
      const closeSide = p.side === 'LONG' ? 4 : 2;
      const reducingSide = p.side === 'LONG' ? 3 : 1;
      const ref = p.exchangePositionRef;
      const [inst] = await db.select({ multiplier: instruments.contractMultiplier }).from(instruments).where(eq(instruments.id, p.instrumentId));
      const known = new Set(
        [
          ...(await db.select({ id: fills.exchangeFillId }).from(fills).where(eq(fills.paperAccountId, acct.id))).map((r) => r.id),
          ...(await db.select({ id: positionExits.exchangeFillId }).from(positionExits).where(eq(positionExits.paperAccountId, acct.id))).map((r) => r.id)
        ]
      );
      const notes: string[] = [];
      const byOrder = new Map<string, Deal[]>();
      let earlier = 0;
      for (const d of deals) {
        if (d.side !== closeSide && d.side !== reducingSide) continue;
        if (d.timestamp < since) {
          earlier += 1;
          continue;
        }
        if (known.has(`mexc:${d.orderId}`)) continue;
        if (d.positionId && ref && d.positionId !== ref) continue;
        byOrder.set(d.orderId, [...(byOrder.get(d.orderId) ?? []), d]);
      }
      const stopRef = p.stopOrderRef?.replace(/^mexc-sl:/, '');
      const stopStillActive = (await stopsFor(symbol)).some((x) => x.stopId === stopRef && x.state === 'ACTIVE');
      const closes: { fill: { fillId: string; contracts: string; price: string; fee: string; filledAt: Date; realizedPnl: string | null }; reason: ExitReason; intentId: string | null }[] = [];
      let listed = D(0);
      const accepted: [string, Deal[], NormalizedOrder | null][] = [];
      for (const [orderId, ds] of byOrder) {
        const ord = await orderById(read, orderId);
        const tied = !!ref && (ds.some((d) => d.positionId === ref) || ord?.positionId === ref);
        if (ord?.positionId && ref && ord.positionId !== ref) {
          notes.push(`MEXC order ${orderId} belongs to position ${ord.positionId}, not ${ref}`);
          continue;
        }
        if (ds.some((d) => d.side === reducingSide) && !tied) {
          notes.push(`MEXC order ${orderId} (side ${reducingSide}) is not tied to position ${ref ?? '(unknown)'}; not treated as this close`);
          continue;
        }
        accepted.push([orderId, ds, ord]);
        listed = listed.plus(ds.reduce((t, d) => t.plus(d.vol), D(0)));
      }
      for (const [orderId, ds, ord] of accepted) {
        const vol = ds.reduce((t, d) => t.plus(d.vol), D(0));
        // A TrendPilot order (externalOid = our client order ID) that is still unresolved is booked by its own job.
        const [own] = ord?.externalOid ? await db.select().from(orderIntents).where(and(eq(orderIntents.paperAccountId, acct.id), eq(orderIntents.clientOrderId, ord.externalOid))) : [];
        if (own && (UNRESOLVED as readonly string[]).includes(own.state)) {
          notes.push(`MEXC order ${orderId} is TrendPilot order ${own.clientOrderId} (${own.state}); booked by its own job`);
          continue;
        }
        // Complete only when MEXC reports the order final with every deal listed (or, when MEXC no
        // longer lists the order, when the listed deals account for the whole difference).
        const complete = ord ? ['FILLED', 'CANCELLED', 'INVALID'].includes(ord.state) && vol.gte(ord.dealVol) : listed.gte(gap);
        if (!complete) {
          notes.push(ord ? `MEXC order ${orderId} is ${ord.state}; deals listed ${vol.toFixed()} of ${ord.dealVol}` : `MEXC no longer lists order ${orderId} and its deals (${vol.toFixed()}) do not cover ${gap.toFixed()}`);
          continue;
        }
        const price = ds.reduce((t, d) => t.plus(D(d.price).times(d.vol)), D(0)).div(vol);
        const fee = ds.reduce((t, d) => t.plus(d.fee), D(0));
        // Realized P&L is stored gross (fees are booked separately). MEXC's deal profit is used when it
        // matches the gross figure; if it matches gross − fee it already includes the fee, which is then
        // added back so the fee is counted once.
        const gross = D(realizedPnl(p.side as 'LONG' | 'SHORT', p.avgEntryPrice, price.toFixed(), vol.toFixed(), inst!.multiplier));
        const profitRaw = ds.every((d) => d.profit !== null) ? ds.reduce((t, d) => t.plus(d.profit!), D(0)) : null;
        const pnl = profitRaw === null ? gross : profitRaw.minus(gross).abs().lte(profitRaw.plus(fee).minus(gross).abs()) ? profitRaw : profitRaw.plus(fee);
        const stopSide = p.side === 'LONG' ? price.lte(p.stopPrice) : price.gte(p.stopPrice);
        const reason: ExitReason = own ? ((own.exitReason as ExitReason | null) ?? 'EXTERNAL_CLOSE') : !stopStillActive && stopSide ? 'STOP_LOSS' : 'EXTERNAL_CLOSE';
        closes.push({
          fill: { fillId: `mexc:${orderId}`, contracts: vol.toFixed(), price: price.toDecimalPlaces(12).toFixed(), fee: fee.toDecimalPlaces(8).toFixed(), filledAt: new Date(Math.max(...ds.map((d) => d.timestamp))), realizedPnl: pnl.toDecimalPlaces(8).toFixed() },
          reason,
          intentId: own?.id ?? null
        });
      }
      if (!byOrder.size && !notes.length) {
        notes.push(`MEXC deal history lists no unbooked closing fill for this position since ${new Date(since).toISOString()} (${deals.length} deals read${earlier ? `, ${earlier} older` : ''})`);
      }
      return { closes, notes };
    };

    /** Closes an open position MEXC no longer holds (fills pending). Exactly once per position. */
    const closeOnExchangeFlat = async (p: PositionRow): Promise<boolean> =>
      db.transaction(async (tx) => {
        const [locked] = await tx.select().from(positions).where(eq(positions.id, p.id)).for('update');
        if (!locked || locked.status !== 'OPEN') return false;
        await book(tx, { id: locked.paperAccountId, ownerId: locked.ownerId }, [
          { kind: 'POSITION_MARGIN_RELEASE', bucket: 'POSITION_MARGIN', amount: D(locked.marginUsdt).neg().toFixed(), refType: 'position', refId: `exchange-flat:${locked.id}`, memo: 'Margin released: closed on MEXC (fill details pending)' }
        ]);
        await tx
          .update(positions)
          .set({
            status: 'CLOSED',
            closeReason: 'EXTERNAL_CLOSE',
            closedAt: locked.exchangeFlatAt ?? now,
            contracts: '0',
            quantity: '0',
            marginUsdt: '0',
            stopContracts: '0',
            protectionStatus: 'PENDING',
            protectionVerifiedAt: now,
            exchangeContracts: '0',
            exchangeCloseState: 'FILLS_PENDING',
            exchangePendingContracts: locked.contracts,
            exchangeFlatAt: locked.exchangeFlatAt ?? now,
            exchangeSyncedAt: now,
            updatedAt: sql`now()`
          })
          .where(eq(positions.id, locked.id));
        await tx.update(positionTargets).set({ status: 'CANCELLED', updatedAt: sql`now()` }).where(and(eq(positionTargets.positionId, locked.id), ne(positionTargets.status, 'DONE')));
        return true;
      });

    const matched = new Set<NormalizedPosition>();
    const reported = new Set<NormalizedPosition>();

    for (const { p, symbol } of open) {
      out.positionsChecked += 1;
      // Same symbol and side, and — once TrendPilot has stored it — the same MEXC position ID.
      const candidate = venuePositions.find((v) => v.symbol === symbol && v.side === p.side);
      const vp = candidate && (!p.exchangePositionRef || candidate.positionId === p.exchangePositionRef) ? candidate : undefined;
      if (vp) matched.add(vp);
      // An opening order in flight changes the size; a fresh close is still being confirmed by its own
      // job. An older unresolved close does not block: its own orders are excluded below.
      const blocking = busy.find((b) => b.instrumentId === p.instrumentId && (b.kind !== 'CLOSE' || now.getTime() - (b.submittedAt ?? b.createdAt).getTime() < INFLIGHT_CLOSE_GRACE_MS));
      if (blocking) {
        out.skipped.push({ positionId: p.id, symbol, reason: `${blocking.kind} order ${blocking.clientOrderId} still in flight` });
        continue;
      }
      const opposite = venuePositions.find((v) => v.symbol === symbol && v.side !== p.side);
      if (opposite) {
        reported.add(opposite);
        out.drift.push({ kind: 'SIDE_MISMATCH', symbol, detail: `MEXC also holds a ${opposite.side} of ${opposite.contracts} contracts`, at });
      }

      const venueQty = vp ? D(vp.contracts) : D(0);
      let platformQty = D(p.contracts);
      let cur = p;
      let reconciledHere = false;

      if (venueQty.lt(platformQty)) {
        // Closed (partly) on MEXC: book the exchange fills not recorded yet.
        venue ??= readOnlyVenue(db, read, conn);
        const stops = await stopsFor(symbol);
        const stopRef = p.stopOrderRef?.replace(/^mexc-sl:/, '');
        for (const c of (await completeCloses(p, symbol, platformQty.minus(venueQty))).closes) {
          const recorded = await db.transaction(async (tx) => {
            const [locked] = await tx.select().from(positions).where(eq(positions.id, p.id)).for('update');
            if (!locked || locked.status !== 'OPEN') return false;
            return (await recordExitFill(db, tx, { position: locked, fill: c.fill, reason: c.reason, intentId: c.intentId, now, venue: venue!, venueConfirmedFlat: venueQty.isZero() })).recorded;
          });
          if (recorded) {
            out.exitsRecorded += 1;
            reconciledHere = true;
          }
        }
        cur = (await db.select().from(positions).where(eq(positions.id, p.id)))[0]!;
        const orphan = stops.find((s) => s.stopId === stopRef && s.state === 'ACTIVE');
        if (cur.status !== 'OPEN') {
          out.closes.push({ positionId: p.id, symbol, result: 'FULL', platformContracts: '0', exchangeContracts: venueQty.toFixed() });
          await db.update(positions).set({ exchangeContracts: '0', exchangeCloseState: null, exchangePendingContracts: null, exchangeFlatAt: cur.exchangeFlatAt ?? now, exchangeSyncedAt: now, updatedAt: sql`now()` }).where(eq(positions.id, p.id));
          if (orphan) out.drift.push({ kind: 'STOP_ORPHANED', symbol, detail: `position closed on MEXC but stop ${orphan.stopId} (${orphan.vol} contracts) is still active there`, at });
          continue;
        }
        platformQty = D(cur.contracts);
        if (venueQty.isZero()) {
          // MEXC holds none of this position (matched by position ID) but has not listed all its
          // closing fills yet: close it now. Opening quantity is kept; remaining goes to zero; the
          // remaining margin is released once (ledger ref per position); price, fees and realized
          // P&L are backfilled from the fills on a later run.
          const closed = await closeOnExchangeFlat(cur);
          out.closes.push({ positionId: p.id, symbol, result: 'FULL_FILLS_PENDING', platformContracts: '0', exchangeContracts: '0', pendingContracts: platformQty.toFixed() });
          if (orphan) out.drift.push({ kind: 'STOP_ORPHANED', symbol, detail: `position closed on MEXC but stop ${orphan.stopId} (${orphan.vol} contracts) is still active there`, at });
          balanceDirty = balanceDirty || closed;
          continue;
        }
        if (venueQty.lt(platformQty)) {
          // MEXC confirms a partial close; its fills are not all listed yet. Nothing more is booked.
          const stop = stops.find((s) => s.stopId === stopRef);
          const coverage = stopCoverage(stop, p.side, venueQty);
          await db
            .update(positions)
            .set({ exchangeContracts: venueQty.toFixed(), exchangeCloseState: 'FILLS_PENDING', exchangeFlatAt: null, exchangeSyncedAt: now, updatedAt: sql`now()` })
            .where(eq(positions.id, p.id));
          out.closes.push({ positionId: p.id, symbol, result: 'FILLS_PENDING', platformContracts: platformQty.toFixed(), exchangeContracts: venueQty.toFixed(), stopCoverage: coverage, stopContracts: stop?.vol ?? null });
          continue;
        }
      }

      if (!venueQty.eq(platformQty)) {
        out.drift.push({ kind: venueQty.gt(platformQty) ? 'UNKNOWN_EXPOSURE' : 'SIZE_MISMATCH', symbol, detail: `MEXC ${p.side} ${venueQty.toFixed()} contracts, TrendPilot ${platformQty.toFixed()}`, at });
        continue;
      }
      if (platformQty.isZero() || !vp) continue;

      // Same size: store the exchange view and verify the stop covers the whole open quantity.
      await db
        .update(positions)
        .set({ exchangePositionRef: vp.positionId, exchangeLiquidationPrice: vp.liquidationPrice, exchangeFundingUsdt: vp.fundingFee, exchangeContracts: venueQty.toFixed(), exchangeCloseState: null, exchangeFlatAt: null, exchangeSyncedAt: now, updatedAt: sql`now()` })
        .where(eq(positions.id, p.id));
      const stopRef = cur.stopOrderRef?.replace(/^mexc-sl:/, '');
      const stop = (await stopsFor(symbol)).find((s) => s.stopId === stopRef);
      const coverage = stopCoverage(stop, p.side, platformQty);
      const covered = coverage === 'FULL';
      const stopDetail = stop ? `stop ${stop.state}, covers ${stop.vol} of ${platformQty.toFixed()}` : 'stop not listed at MEXC';

      if (reconciledHere) {
        // Manual partial close: show what the active stop covers now. Nothing is sent.
        out.closes.push({ positionId: p.id, symbol, result: 'PARTIAL', platformContracts: platformQty.toFixed(), exchangeContracts: venueQty.toFixed(), stopCoverage: coverage, stopContracts: stop?.vol ?? null });
        await db
          .update(positions)
          .set({ protectionStatus: covered ? 'PROTECTED' : 'UNPROTECTED', stopContracts: coverage === 'NONE' ? null : stop!.vol, protectionVerifiedAt: now, updatedAt: sql`now()` })
          .where(eq(positions.id, p.id));
        if (!covered) out.drift.push({ kind: 'STOP_MISSING', symbol, detail: `after a close on MEXC: ${stopDetail}`, at });
        continue;
      }
      if (!covered) {
        // Shown and halted, never acted on here: the sync does not place, cancel or retry orders.
        if (cur.protectionStatus === 'PROTECTED') out.protectionFailures += 1;
        out.drift.push({ kind: 'STOP_MISSING', symbol, detail: stopDetail, at });
        await db
          .update(positions)
          .set({ protectionStatus: 'UNPROTECTED', stopContracts: coverage === 'NONE' ? null : stop!.vol, protectionVerifiedAt: now, updatedAt: sql`now()` })
          .where(and(eq(positions.id, p.id), eq(positions.status, 'OPEN')));
      } else if (cur.protectionStatus !== 'PROTECTED' || cur.stopContracts === null || !D(cur.stopContracts).eq(stop!.vol)) {
        await db.update(positions).set({ protectionStatus: 'PROTECTED', stopContracts: stop!.vol, protectionVerifiedAt: now, updatedAt: sql`now()` }).where(and(eq(positions.id, p.id), eq(positions.status, 'OPEN')));
      }
    }

    // Positions closed on MEXC whose fills were pending: book price, fees and realized P&L once they
    // are listed (no quantity or margin change — both were settled when the position closed).
    const pendingClosed = await db
      .select({ p: positions, symbol: instruments.exchangeSymbol })
      .from(positions)
      .innerJoin(instruments, eq(instruments.id, positions.instrumentId))
      .where(and(eq(positions.paperAccountId, acct.id), eq(positions.status, 'CLOSED'), eq(positions.exchangeCloseState, 'FILLS_PENDING')));
    for (const { p, symbol } of pendingClosed) {
      const pending = D(p.exchangePendingContracts ?? '0');
      if (pending.lte(0)) continue;
      let found: Awaited<ReturnType<typeof completeCloses>>;
      try {
        found = await completeCloses(p, symbol, pending);
      } catch (e) {
        // History unavailable: values stay pending with the reason; nothing else on the account depends on it.
        const reason = `MEXC history unavailable: ${(e as Error).message}`.slice(0, 300);
        await db.update(positions).set({ exchangePendingReason: reason, updatedAt: sql`now()` }).where(eq(positions.id, p.id));
        out.skipped.push({ positionId: p.id, symbol, reason });
        continue;
      }
      const candidates = found.closes;
      for (const c of candidates) {
        const booked = await db.transaction(async (tx) => {
          const [locked] = await tx.select().from(positions).where(eq(positions.id, p.id)).for('update');
          if (!locked || locked.exchangeCloseState !== 'FILLS_PENDING') return false;
          const left = D(locked.exchangePendingContracts ?? '0');
          const qty = Decimal.min(c.fill.contracts, left);
          if (qty.lte(0)) return false;
          const [inst] = await tx.select({ multiplier: instruments.contractMultiplier }).from(instruments).where(eq(instruments.id, locked.instrumentId));
          const pnl = c.fill.realizedPnl !== null && qty.eq(c.fill.contracts) ? D(c.fill.realizedPnl).toFixed() : realizedPnl(locked.side as 'LONG' | 'SHORT', locked.avgEntryPrice, c.fill.price, qty.toFixed(), inst!.multiplier);
          const [exit] = await tx
            .insert(positionExits)
            .values({ ownerId: locked.ownerId, paperAccountId: locked.paperAccountId, positionId: locked.id, intentId: c.intentId, reason: c.reason, exchangeFillId: c.fill.fillId, contracts: qty.toFixed(), price: c.fill.price, fee: c.fill.fee, realizedPnl: pnl, marginReleased: '0', remainingContracts: '0', filledAt: c.fill.filledAt })
            .onConflictDoNothing({ target: [positionExits.paperAccountId, positionExits.exchangeFillId] })
            .returning({ id: positionExits.id });
          if (!exit) return false;
          await book(tx, { id: locked.paperAccountId, ownerId: locked.ownerId }, [
            { kind: 'REALIZED_PNL', bucket: 'WALLET', amount: pnl, refType: 'fill', refId: c.fill.fillId, memo: `Realized P&L (${c.reason}, backfilled from MEXC)` },
            { kind: 'TRADING_FEE', bucket: 'WALLET', amount: D(c.fill.fee).neg().toFixed(), refType: 'fill', refId: c.fill.fillId, memo: 'MEXC fee (exit, backfilled)' }
          ]);
          const remainingPending = left.minus(qty);
          const done = remainingPending.lte(0);
          await tx
            .update(positions)
            .set({
              realizedPnlUsdt: D(locked.realizedPnlUsdt).plus(pnl).toFixed(),
              feesUsdt: D(locked.feesUsdt).plus(c.fill.fee).toFixed(),
              exchangePendingContracts: done ? null : remainingPending.toFixed(),
              exchangePendingReason: null,
              ...(done ? { exchangeCloseState: null, closedAt: c.fill.filledAt, ...(c.reason !== 'EXTERNAL_CLOSE' && locked.closeReason === 'EXTERNAL_CLOSE' ? { closeReason: c.reason } : {}) } : {}),
              updatedAt: sql`now()`
            })
            .where(eq(positions.id, locked.id));
          return true;
        });
        if (booked) out.exitsRecorded += 1;
      }
      const [after] = await db.select({ state: positions.exchangeCloseState, pending: positions.exchangePendingContracts }).from(positions).where(eq(positions.id, p.id));
      if (after?.state === 'FILLS_PENDING') {
        const reason = (found.notes.join('; ') || 'Closing fills listed by MEXC do not cover the closed quantity yet').slice(0, 500);
        await db.update(positions).set({ exchangePendingReason: reason, updatedAt: sql`now()` }).where(eq(positions.id, p.id));
      }
      if (candidates.length) out.closes.push({ positionId: p.id, symbol, result: after?.state ? 'FULL_FILLS_PENDING' : 'FILLS_BACKFILLED', platformContracts: '0', exchangeContracts: '0', ...(after?.pending ? { pendingContracts: D(after.pending).toFixed() } : {}) });
    }

    // Exposure at MEXC on a contract this investor trades Live, unknown to TrendPilot.
    const traded = await db
      .select({ symbol: instruments.exchangeSymbol })
      .from(orderBlocks)
      .innerJoin(instruments, eq(instruments.id, orderBlocks.instrumentId))
      .where(and(eq(orderBlocks.ownerId, ownerId), eq(orderBlocks.mode, 'LIVE')));
    const tradedSymbols = new Set(traded.map((t) => t.symbol));
    for (const vp of venuePositions) {
      if (matched.has(vp) || reported.has(vp) || !tradedSymbols.has(vp.symbol)) continue;
      if (open.some((o) => o.symbol === vp.symbol && inFlight.has(o.p.instrumentId))) continue;
      const [inst] = await db.select({ id: instruments.id }).from(instruments).where(eq(instruments.exchangeSymbol, vp.symbol));
      if (inst && inFlight.has(inst.id)) continue;
      const older = open.find((o) => o.symbol === vp.symbol && o.p.side === vp.side && o.p.exchangePositionRef && o.p.exchangePositionRef !== vp.positionId);
      out.drift.push({
        kind: 'UNKNOWN_EXPOSURE',
        symbol: vp.symbol,
        detail: older
          ? `MEXC position ${vp.positionId} (${vp.side} ${vp.contracts}) is not TrendPilot's position ${older.p.exchangePositionRef}`
          : `MEXC holds a ${vp.side} of ${vp.contracts} contracts that TrendPilot did not open`,
        at
      });
    }

    // Booked exits moved the local wallet by their P&L and fees, which MEXC's balance already
    // contains: match it to MEXC again so wallet, margin and available agree at the end of the run.
    if (usdt && (out.exitsRecorded > 0 || balanceDirty)) {
      const b = await applyExchangeBalance(db, ownerId, usdt, `sync:${conn.id}:${at}:after-exits`, now);
      out.balance = { equity: usdt.equity, available: usdt.availableOpen, walletAdjustment: D(out.balance?.walletAdjustment ?? 0).plus(b.walletAdjustment).toFixed() };
    }

    if (out.drift.length) await haltConnectionEntries(db, ownerId, `DRIFT ${out.drift.map((d) => `${d.kind} ${d.symbol}`).join(', ')}`.slice(0, 200), null, 'live-sync');
    // Drift = what this complete run found: resolved items disappear, remaining ones keep their reason.
    // Halts (operator, investor or drift) stay until someone resumes them.
    await db
      .update(exchangeConnections)
      .set({ lastSyncAt: now, lastSyncOkAt: now, lastSyncError: null, drift: out.drift, syncLeaseUntil: null, updatedAt: sql`now()` })
      .where(eq(exchangeConnections.id, conn.id));
    out.ok = true;
    return out;
  } catch (e) {
    const msg = (e instanceof LiveVenueUnavailable ? e.message : ((e as Error).message ?? 'sync failed')).slice(0, 300);
    // A failed run leaves positions and the last drift as they were.
    await db.update(exchangeConnections).set({ lastSyncAt: now, lastSyncError: msg, syncLeaseUntil: null, updatedAt: sql`now()` }).where(eq(exchangeConnections.id, conn.id));
    return { ...out, error: msg };
  }
}

/** Owners whose Live accounts need syncing: verified connections that are active or still hold Live exposure. */
export async function liveAccountsToSync(db: Db): Promise<string[]> {
  const conns = await db.select({ ownerId: exchangeConnections.ownerId, liveEnabled: exchangeConnections.liveEnabled }).from(exchangeConnections).where(eq(exchangeConnections.status, 'VERIFIED'));
  const out: string[] = [];
  for (const c of conns) {
    if (c.liveEnabled) {
      out.push(c.ownerId);
      continue;
    }
    const [acct] = await db.select({ id: paperAccounts.id }).from(paperAccounts).where(and(eq(paperAccounts.ownerId, c.ownerId), eq(paperAccounts.mode, 'LIVE')));
    if (!acct) continue;
    const [pos] = await db.select({ id: positions.id }).from(positions).where(and(eq(positions.paperAccountId, acct.id), eq(positions.status, 'OPEN')));
    if (pos) out.push(c.ownerId);
  }
  return out;
}

export async function syncAllLiveAccounts(db: Db, now: Date, opts: { env?: Record<string, string | undefined> } = {}): Promise<LiveSyncSummary[]> {
  const out: LiveSyncSummary[] = [];
  for (const ownerId of await liveAccountsToSync(db)) out.push(await syncLiveAccount(db, ownerId, now, opts));
  return out;
}
