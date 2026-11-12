import { and, eq, inArray, sql } from 'drizzle-orm';
import { Decimal, type ExitReason } from '@trendpilot/domain';
import type { Db } from '../client';
import { exchangeConnections, fills, instruments, orderBlocks, orderIntents, paperAccounts, positionExits, positions } from '../schema';
import { lockPaperAccount } from '../paper/accounts';
import { recordExitFill, requestExit } from '../paper/exits';
import type { ExecutionVenue } from '../venue/types';
import { applyExchangeBalance, connectionFor, haltConnectionEntries, LiveVenueUnavailable, resolveAccountVenue, type ConnectionRow } from './liveMode';
import { MexcHttpTransport, MEXC_PRIVATE_DEFAULT_BASE_URL, normalizeAssets, normalizePositions, normalizeStops, type MexcRequester, type NormalizedPosition } from './mexcPrivate';
import { open as unseal } from '../security/secretBox';
import { mexcVenue } from './mexcVenue';

/**
 * Private MEXC sync for one Live account (REP-01, OPS-03). Runs in the worker on a schedule and
 * on demand. Read-only towards MEXC except for the protective actions it queues through the normal
 * close path. Per run:
 *  1. Balance: the Live wallet follows MEXC's cash balance (equity − unrealized) through an
 *     EXCHANGE_BALANCE_SYNC ledger row; equity and available-to-open are stored for display and
 *     for the entry margin check.
 *  2. Positions, for every open Live position with no order in flight:
 *     - same size at MEXC → store MEXC positionId, liquidation price and cumulative funding, and
 *       verify the stop still covers the whole position (else: UNPROTECTED, entries halted,
 *       emergency close queued);
 *     - smaller at MEXC → book the exchange-side close fills found in MEXC's deal history once
 *       each (stop loss when the stop is gone, otherwise a close made on MEXC), then re-compare;
 *     - anything still different (or exposure TrendPilot does not know on a traded contract) →
 *       drift recorded and new entries halted until an operator reviews it.
 */

const D = (v: Decimal.Value) => new Decimal(v);
const UNRESOLVED = ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'] as const;

export interface DriftItem {
  kind: 'SIZE_MISMATCH' | 'UNKNOWN_EXPOSURE' | 'SIDE_MISMATCH' | 'STOP_MISSING';
  symbol: string;
  detail: string;
  at: string;
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
  timestamp: number;
}
/** Deal history (`order/list/order_deals/v3`). The docs show both a paginated wrapper and a bare array. */
export function normalizeDealHistory(data: unknown): Deal[] {
  const list = Array.isArray(data) ? data : ((data as { resultList?: unknown[] } | null)?.resultList ?? []);
  const seen = new Map<string, Deal>();
  for (const d of list as Record<string, unknown>[]) {
    const id = String(d.id);
    if (seen.has(id)) continue;
    seen.set(id, { id, orderId: String(d.orderId ?? ''), side: Number(d.side), vol: D(String(d.vol ?? 0)).toFixed(), price: D(String(d.price ?? 0)).toFixed(), fee: D(String(d.fee ?? 0)).toFixed(), timestamp: Number(d.timestamp ?? 0) });
  }
  return [...seen.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}

/** The venue used to record exchange-side exits: the full Live venue, or read-only when orders are off. */
async function venueForSync(db: Db, acctId: string, ownerId: string, conn: ConnectionRow, read: MexcRequester, injected?: ExecutionVenue): Promise<ExecutionVenue> {
  try {
    return await resolveAccountVenue(db, { mode: 'LIVE', paperAccountId: acctId, ownerId }, injected);
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    // Transport off: reads still work; cancels are skipped (a triggered stop is already gone).
    const v = mexcVenue({
      requester: read,
      symbolFor: async (instrumentId) => (await db.select({ s: instruments.exchangeSymbol }).from(instruments).where(eq(instruments.id, instrumentId)))[0]?.s ?? '',
      positionMode: (conn.positionMode as 'ONE_WAY' | 'HEDGE') ?? 'ONE_WAY'
    });
    return { ...v, cancelOrder: async () => undefined };
  }
}

export async function syncLiveAccount(db: Db, ownerId: string, now: Date, opts: { env?: Record<string, string | undefined>; venue?: ExecutionVenue } = {}): Promise<LiveSyncSummary> {
  const env = opts.env ?? process.env;
  const out: LiveSyncSummary = { ownerId, ok: false, positionsChecked: 0, exitsRecorded: 0, protectionFailures: 0, drift: [] };
  const conn = await connectionFor(db, ownerId);
  if (!conn || conn.status === 'REVOKED' || !conn.apiKeySealed) return { ...out, error: 'no connection' };
  const at = now.toISOString();
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
    const busy = await db.select({ instrumentId: orderIntents.instrumentId }).from(orderIntents).where(and(eq(orderIntents.paperAccountId, acct.id), inArray(orderIntents.state, [...UNRESOLVED])));
    const inFlight = new Set(busy.map((b) => b.instrumentId));
    const stopsBySymbol = new Map<string, ReturnType<typeof normalizeStops>>();
    const stopsFor = async (symbol: string) => {
      if (!stopsBySymbol.has(symbol)) stopsBySymbol.set(symbol, normalizeStops(await read.request('GET', '/api/v1/private/stoporder/open_orders', { symbol })));
      return stopsBySymbol.get(symbol)!;
    };
    let venue: ExecutionVenue | null = null;
    const matched = new Set<NormalizedPosition>();

    for (const { p, symbol } of open) {
      out.positionsChecked += 1;
      const vp = venuePositions.find((v) => v.symbol === symbol && v.side === p.side);
      if (vp) matched.add(vp);
      if (inFlight.has(p.instrumentId)) continue; // an order is being reconciled by its own job
      const opposite = venuePositions.find((v) => v.symbol === symbol && v.side !== p.side);
      if (opposite) out.drift.push({ kind: 'SIDE_MISMATCH', symbol, detail: `MEXC also holds a ${opposite.side} of ${opposite.contracts} contracts`, at });

      let venueQty = vp ? D(vp.contracts) : D(0);
      let platformQty = D(p.contracts);

      if (venueQty.lt(platformQty)) {
        // Closed (partly) at MEXC: book the exchange fills not recorded yet.
        venue ??= await venueForSync(db, acct.id, ownerId, conn, read, opts.venue);
        const deals = normalizeDealHistory(await read.request('GET', '/api/v1/private/order/list/order_deals/v3', { symbol, start_time: p.openedAt.getTime() - 60_000, page_num: 1, page_size: 1000 }));
        const closeSide = p.side === 'LONG' ? 4 : 2;
        const known = new Set(
          [
            ...(await db.select({ id: fills.exchangeFillId }).from(fills).where(eq(fills.paperAccountId, acct.id))).map((r) => r.id),
            ...(await db.select({ id: positionExits.exchangeFillId }).from(positionExits).where(eq(positionExits.paperAccountId, acct.id))).map((r) => r.id)
          ]
        );
        const byOrder = new Map<string, Deal[]>();
        for (const d of deals) {
          if (d.side !== closeSide || d.timestamp < p.openedAt.getTime() - 60_000) continue;
          if (known.has(`mexc:${d.orderId}`)) continue;
          byOrder.set(d.orderId, [...(byOrder.get(d.orderId) ?? []), d]);
        }
        const stops = await stopsFor(symbol);
        const stopRef = p.stopOrderRef?.replace(/^mexc-sl:/, '');
        const stopStillActive = stops.some((s) => s.stopId === stopRef && s.state === 'ACTIVE');
        for (const [orderId, ds] of byOrder) {
          const vol = ds.reduce((t, d) => t.plus(d.vol), D(0));
          const price = ds.reduce((t, d) => t.plus(D(d.price).times(d.vol)), D(0)).div(vol);
          const fee = ds.reduce((t, d) => t.plus(d.fee), D(0));
          const stopSide = p.side === 'LONG' ? price.lte(p.stopPrice) : price.gte(p.stopPrice);
          const reason: ExitReason = !stopStillActive && stopSide ? 'STOP_LOSS' : 'EXTERNAL_CLOSE';
          const recorded = await db.transaction(async (tx) => {
            const [locked] = await tx.select().from(positions).where(eq(positions.id, p.id)).for('update');
            if (!locked || locked.status !== 'OPEN') return false;
            const fill = { fillId: `mexc:${orderId}`, contracts: vol.toFixed(), price: price.toDecimalPlaces(12).toFixed(), fee: fee.toDecimalPlaces(8).toFixed(), filledAt: new Date(Math.max(...ds.map((d) => d.timestamp))) };
            return (await recordExitFill(db, tx, { position: locked, fill, reason, intentId: null, now, venue: venue! })).recorded;
          });
          if (recorded) out.exitsRecorded += 1;
        }
        const [after] = await db.select().from(positions).where(eq(positions.id, p.id));
        platformQty = after?.status === 'OPEN' ? D(after.contracts) : D(0);
        venueQty = vp ? D(vp.contracts) : D(0);
      }

      if (!venueQty.eq(platformQty)) {
        out.drift.push({ kind: venueQty.gt(platformQty) ? 'UNKNOWN_EXPOSURE' : 'SIZE_MISMATCH', symbol, detail: `MEXC ${p.side} ${venueQty.toFixed()} contracts, TrendPilot ${platformQty.toFixed()}`, at });
        continue;
      }
      if (platformQty.isZero() || !vp) continue;

      // Same size: store the exchange view and verify the stop still covers the whole position.
      await db
        .update(positions)
        .set({ exchangePositionRef: vp.positionId, exchangeLiquidationPrice: vp.liquidationPrice, exchangeFundingUsdt: vp.fundingFee, exchangeSyncedAt: now, updatedAt: sql`now()` })
        .where(eq(positions.id, p.id));
      const stopRef = p.stopOrderRef?.replace(/^mexc-sl:/, '');
      const stop = (await stopsFor(symbol)).find((s) => s.stopId === stopRef);
      const covered = !!stop && stop.state === 'ACTIVE' && !stop.reverse && D(stop.vol).eq(platformQty) && stop.positionSide === p.side;
      if (!covered && p.protectionStatus === 'PROTECTED') {
        out.protectionFailures += 1;
        out.drift.push({ kind: 'STOP_MISSING', symbol, detail: stop ? `stop ${stop.state}, covers ${stop.vol} of ${platformQty.toFixed()}` : 'stop not listed at MEXC', at });
        await db.transaction(async (tx) => {
          const [locked] = await tx.select().from(positions).where(eq(positions.id, p.id)).for('update');
          if (!locked || locked.status !== 'OPEN') return;
          await tx.update(positions).set({ protectionStatus: 'UNPROTECTED', stopContracts: stop?.vol ?? null, updatedAt: sql`now()` }).where(eq(positions.id, p.id));
          // OPS-03: exposure without a verified stop is closed at once.
          await requestExit(tx, { position: { ...locked, protectionStatus: 'UNPROTECTED' }, reason: 'PROTECTION_FAILURE', now });
        });
      }
    }

    // Exposure at MEXC on a contract this investor trades Live, unknown to TrendPilot.
    const traded = await db
      .select({ symbol: instruments.exchangeSymbol })
      .from(orderBlocks)
      .innerJoin(instruments, eq(instruments.id, orderBlocks.instrumentId))
      .where(and(eq(orderBlocks.ownerId, ownerId), eq(orderBlocks.mode, 'LIVE')));
    const tradedSymbols = new Set(traded.map((t) => t.symbol));
    for (const vp of venuePositions) {
      if (matched.has(vp) || !tradedSymbols.has(vp.symbol)) continue;
      if (open.some((o) => o.symbol === vp.symbol && inFlight.has(o.p.instrumentId))) continue;
      const [inst] = await db.select({ id: instruments.id }).from(instruments).where(eq(instruments.exchangeSymbol, vp.symbol));
      if (inst && inFlight.has(inst.id)) continue;
      if (open.some((o) => o.symbol === vp.symbol)) continue; // already reported as a side mismatch
      out.drift.push({ kind: 'UNKNOWN_EXPOSURE', symbol: vp.symbol, detail: `MEXC holds a ${vp.side} of ${vp.contracts} contracts that TrendPilot did not open`, at });
    }

    if (out.drift.length) await haltConnectionEntries(db, ownerId, `DRIFT ${out.drift.map((d) => `${d.kind} ${d.symbol}`).join(', ')}`.slice(0, 200), null, 'live-sync');
    await db
      .update(exchangeConnections)
      .set({ lastSyncAt: now, lastSyncError: null, ...(out.drift.length ? { drift: out.drift } : {}), updatedAt: sql`now()` })
      .where(eq(exchangeConnections.id, conn.id));
    out.ok = true;
    return out;
  } catch (e) {
    const msg = (e instanceof LiveVenueUnavailable ? e.message : (e as Error).message ?? 'sync failed').slice(0, 300);
    await db.update(exchangeConnections).set({ lastSyncAt: now, lastSyncError: msg, updatedAt: sql`now()` }).where(eq(exchangeConnections.id, conn.id));
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
