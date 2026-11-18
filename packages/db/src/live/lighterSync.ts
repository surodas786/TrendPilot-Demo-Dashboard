import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { Decimal, decimalsOfStep, planStopRenewal } from '@trendpilot/domain';
import type { Db } from '../client';
import { book, lockPaperAccount } from '../paper/accounts';
import { recordExitFill } from '../paper/exits';
import { exchangeConnections, instruments, lighterTxs, orderIntents, positions, positionTargets } from '../schema';
import type { ExecutionVenue } from '../venue/types';
import { lighterApiFor, lighterExposure, lighterLiveInputs, lighterScopeOf, lighterSignerFor } from './lighterConnection';
import { lighterVenue } from './lighterOrders';
import { livePilotVerified } from './capabilities';
import { scrubLighterSignerAccount } from './lighterWasmSigner';
import { LighterSignerUnavailable, type LighterAccountSnapshot, type LighterApi, type LighterSigner } from './lighterPrivate';
import type { DriftItem } from './liveSync';
import { applyExchangeBalance, capabilityStateOf, getLiveControl, haltConnectionEntries } from './liveMode';

/**
 * Lighter account reconciliation (Lighter plan Step 4) — manual Sync and the scheduled run use
 * this same code. Every Lighter call here is a READ, except a stop resize after a partial close made
 * on Lighter (protection for the remainder, only when that capability is verified). Per run, for the
 * investor's OWN verified Lighter account:
 *  1. Snapshot (GET /api/v1/account): USDC collateral / available / positions. The Live Lighter
 *     account (USDC, separate from every USDT account) follows it through an EXCHANGE_BALANCE_SYNC
 *     ledger row. Lighter's own funding total per position is shown (account state); TrendPilot
 *     books no Lighter funding and simulates none.
 *  2. Each open TrendPilot Lighter position with no order in flight, matched by market ID:
 *     - native stop FILLED at Lighter → its actual fills are booked once (reason STOP_LOSS);
 *     - smaller or gone at Lighter without listed fills → gone: Closed with fill details pending
 *       (margin released, targets cancelled); smaller: the remainder is recorded, protection is
 *       re-checked (and the stop resized when verified), entries halted until reviewed;
 *     - same size → stop coverage re-checked against the position (needs the signer for reads).
 *  3. Exposure TrendPilot does not manage, the opposite side, or orders resting on a market without
 *     a managed position → drift, and new Lighter entries halted. Nothing is ever cancelled or
 *     closed by reconciliation; it never replays a signal or queues an entry.
 * Runs are serialised per connection by the sync lease; fills are unique per Lighter order.
 */

const D = (v: Decimal.Value) => new Decimal(v);
const SYNC_LEASE_SECONDS = 120;
const UNRESOLVED = ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'] as const;
export const LIGHTER_SYNC_BUSY = 'A Lighter sync for this account is already running; try again in a moment.';

export interface LighterSyncSummary {
  connectionId: string;
  ok: boolean;
  busy?: boolean;
  error?: string;
  balance?: { collateral: string; available: string };
  positionsChecked: number;
  stopFillsBooked: number;
  closedOnLighter: { positionId: string; result: 'STOP_FILLED' | 'FLAT_FILLS_PENDING' | 'REDUCED_FILLS_PENDING'; lighterSize: string }[];
  protection: { positionId: string; status: 'PROTECTED' | 'UNPROTECTED' | 'UNKNOWN'; detail?: string; stopExpiresAt?: string | null; renewal?: string }[];
  drift: DriftItem[];
  skipped: { positionId: string; reason: string }[];
}

export async function syncLighterConnection(db: Db, connectionId: string, now: Date, o: { api?: LighterApi; signer?: LighterSigner; env?: Record<string, string | undefined> } = {}): Promise<LighterSyncSummary> {
  const env = o.env ?? process.env;
  const out: LighterSyncSummary = { connectionId, ok: false, positionsChecked: 0, stopFillsBooked: 0, closedOnLighter: [], protection: [], drift: [], skipped: [] };
  const [conn] = await db.select().from(exchangeConnections).where(eq(exchangeConnections.id, connectionId));
  if (!conn || conn.exchange !== 'LIGHTER' || conn.status !== 'VERIFIED') return { ...out, error: 'no verified Lighter connection' };
  const [lease] = await db
    .update(exchangeConnections)
    .set({ syncLeaseUntil: sql`now() + make_interval(secs => ${SYNC_LEASE_SECONDS})` })
    .where(and(eq(exchangeConnections.id, conn.id), sql`(${exchangeConnections.syncLeaseUntil} IS NULL OR ${exchangeConnections.syncLeaseUntil} < now())`))
    .returning({ id: exchangeConnections.id });
  if (!lease) return { ...out, error: LIGHTER_SYNC_BUSY, busy: true };
  const at = now.toISOString();
  try {
    const api = o.api ?? lighterApiFor(conn, env);
    const signer = o.signer ?? lighterSignerFor(conn);
    const scope = lighterScopeOf(conn);
    const snap = await api.account(scope.accountIndex);
    if (!snap) throw new Error(`Lighter account ${scope.accountIndex} not found`);

    // Testnet: the snapshot is stored on the connection only — never in the Live ledger or Holdings.
    if (conn.venueEnvironment !== 'MAINNET') {
      await db
        .update(exchangeConnections)
        .set({ accountState: { ...accountStateOf(snap, now), environment: conn.venueEnvironment }, lastSyncAt: now, lastSyncOkAt: now, lastSyncError: null, revision: sql`${exchangeConnections.revision} + 1`, updatedAt: sql`now()` })
        .where(eq(exchangeConnections.id, conn.id));
      out.ok = true;
      return out;
    }

    // 1. Balance (USDC) → the Live Lighter account; unrealized from Lighter's positions.
    const unrealized = snap.positions.reduce((t, p) => t.plus(p.unrealizedPnl ?? 0), D(0));
    const equity = snap.totalAssetValue ?? D(snap.collateral).plus(unrealized).toFixed();
    await applyExchangeBalance(db, conn.ownerId, { equity, availableOpen: snap.availableBalance, unrealized: unrealized.toFixed() }, `lighter-sync:${conn.id}:${at}`, now, 'LIGHTER');
    out.balance = { collateral: snap.collateral, available: snap.availableBalance };
    const acct = await db.transaction((tx) => lockPaperAccount(tx, conn.ownerId, 'LIVE', 'LIGHTER', { lighterLiveLedger: true }));

    const capabilities = capabilityStateOf(await getLiveControl(db));
    const venue: ExecutionVenue = lighterVenue({
      db,
      scope,
      api,
      signer,
      inputs: lighterLiveInputs(env),
      capabilities,
      marketFor: async (instrumentId) => {
        const [i] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
        if (!i || i.exchange !== 'LIGHTER' || i.exchangeMarketId === null) throw new Error(`instrument ${instrumentId} is not a Lighter market`);
        return lighterMarketOf(i);
      },
      confirm: { attempts: 1, delayMs: 0 }
    });

    const open = await db
      .select({ p: positions, marketId: instruments.exchangeMarketId, symbol: instruments.symbol })
      .from(positions)
      .innerJoin(instruments, eq(instruments.id, positions.instrumentId))
      .where(and(eq(positions.paperAccountId, acct.id), eq(positions.status, 'OPEN')));
    const busy = await db
      .select({ instrumentId: orderIntents.instrumentId, clientOrderId: orderIntents.clientOrderId, kind: orderIntents.kind })
      .from(orderIntents)
      .where(and(eq(orderIntents.paperAccountId, acct.id), inArray(orderIntents.state, [...UNRESOLVED])));
    const managedMarkets = new Set(open.map((r) => r.marketId));

    for (const { p, marketId, symbol } of open) {
      out.positionsChecked += 1;
      const inflight = busy.find((b) => b.instrumentId === p.instrumentId);
      if (inflight) {
        out.skipped.push({ positionId: p.id, reason: `${inflight.kind} order ${inflight.clientOrderId} still in flight` });
        continue;
      }
      const lp = snap.positions.find((x) => x.marketId === marketId);
      const size = lp && lp.side ? D(lp.size) : D(0);
      if (lp && lp.side && lp.side !== p.side) {
        out.drift.push({ kind: 'SIDE_MISMATCH', symbol, detail: `Lighter holds ${lp.side} ${lp.size} on market ${marketId}; TrendPilot manages ${p.side} ${p.contracts}`, at });
        continue;
      }
      let cur: typeof p | undefined = p;
      if (size.lt(p.contracts)) {
        // Closed (partly) on Lighter. First the native stop's own fills, when they can be read.
        const booked = await bookStopFill(db, venue, api, signer, scope.accountIndex, p, now).catch((e) => {
          if (e instanceof LighterSignerUnavailable) return null;
          throw e;
        });
        if (booked) {
          out.stopFillsBooked += 1;
          out.closedOnLighter.push({ positionId: p.id, result: 'STOP_FILLED', lighterSize: size.toFixed() });
          [cur] = await db.select().from(positions).where(eq(positions.id, p.id));
        }
        if (cur!.status === 'OPEN' && size.lt(cur!.contracts)) {
          if (size.isZero()) {
            await closeFlatFillsPending(db, cur!, now);
            out.closedOnLighter.push({ positionId: p.id, result: 'FLAT_FILLS_PENDING', lighterSize: '0' });
          } else {
            await db
              .update(positions)
              .set({ exchangeContracts: size.toFixed(), exchangeCloseState: 'FILLS_PENDING', exchangePendingContracts: D(cur!.contracts).minus(size).toFixed(), exchangePendingReason: 'Reduced on Lighter; fill details pending', exchangeSyncedAt: now, updatedAt: sql`now()` })
              .where(eq(positions.id, p.id));
            out.closedOnLighter.push({ positionId: p.id, result: 'REDUCED_FILLS_PENDING', lighterSize: size.toFixed() });
            out.drift.push({ kind: 'SIZE_MISMATCH', symbol, detail: `Lighter holds ${size.toFixed()} of the ${cur!.contracts} TrendPilot manages (reduced on Lighter; fills pending)`, at });
            // Protection for the remainder: the stop must cover what Lighter holds now.
            if (cur!.stopOrderRef) await venue.resizeProtection(cur!.stopOrderRef, size.toFixed(), p.instrumentId).catch(() => undefined);
          }
        }
        [cur] = await db.select().from(positions).where(eq(positions.id, p.id));
        if (cur!.status !== 'OPEN') continue;
      } else if (size.gt(p.contracts)) {
        out.drift.push({ kind: 'SIZE_MISMATCH', symbol, detail: `Lighter holds ${size.toFixed()}, more than the ${p.contracts} TrendPilot manages`, at });
      }
      // Stop coverage for what Lighter holds (reads need the signer's auth token).
      const held = size.isZero() ? D(cur!.contracts) : Decimal.min(size, cur!.contracts);
      try {
        const s = cur!.stopOrderRef ? await venue.inspectProtection(cur!.stopOrderRef, p.instrumentId) : null;
        const ok = !!s && s.status === 'ACTIVE' && s.reduceOnly && s.side === (p.side === 'LONG' ? 'SHORT' : 'LONG') && D(s.contracts).eq(held);
        await db
          .update(positions)
          .set({ protectionStatus: ok ? 'PROTECTED' : 'UNPROTECTED', stopContracts: s?.contracts ?? null, protectionVerifiedAt: now, exchangeLiquidationPrice: lp?.liquidationPrice ?? null, exchangeSyncedAt: now, updatedAt: sql`now()` })
          .where(eq(positions.id, p.id));
        // Native stop expiry: detected and alerted; renewal is not sent in this build (see planStopRenewal).
        const plan = ok
          ? planStopRenewal({ expiresAtMs: s?.expiresAt ? Date.parse(s.expiresAt) : null, nowMs: Date.now() /* exchange wall time, not the signal clock */, leadMs: lighterStopRenewLeadMs(env), renewVerified: livePilotVerified('LIGHTER_STOP_RENEW', capabilities), previous: null })
          : null;
        const renewal = plan && plan.action !== 'NONE' ? (plan.action === 'RENEW' ? 'STOP_EXPIRING: renewal is not implemented in this build; new entries halted' : plan.reason) : undefined;
        out.protection.push({ positionId: p.id, status: ok ? 'PROTECTED' : 'UNPROTECTED', stopExpiresAt: s?.expiresAt ?? null, ...(renewal ? { renewal } : {}), ...(ok ? {} : { detail: s ? `stop ${s.status}, ${s.contracts} of ${held.toFixed()}` : 'no stop at Lighter' }) });
        if (!ok) out.drift.push({ kind: 'STOP_MISSING', symbol, detail: s ? `Lighter stop is ${s.status} and covers ${s.contracts} of ${held.toFixed()}` : 'Lighter holds no stop for this position', at });
        else if (renewal) out.drift.push({ kind: 'STOP_EXPIRING', symbol, detail: `Lighter stop expires ${s!.expiresAt}: ${renewal}`, at });
      } catch (e) {
        if (!(e instanceof LighterSignerUnavailable)) throw e;
        out.protection.push({ positionId: p.id, status: 'UNKNOWN', detail: 'stop orders cannot be read without the Lighter signer' });
        await db.update(positions).set({ exchangeLiquidationPrice: lp?.liquidationPrice ?? null, exchangeSyncedAt: now, updatedAt: sql`now()` }).where(eq(positions.id, p.id));
      }
    }

    // 3. Exposure and resting orders TrendPilot does not manage.
    for (const lp of snap.positions) {
      if (managedMarkets.has(lp.marketId)) continue;
      if (lp.side && D(lp.size).gt(0)) out.drift.push({ kind: 'UNKNOWN_EXPOSURE', symbol: lp.symbol || String(lp.marketId), detail: `Lighter holds ${lp.side} ${lp.size} on market ${lp.marketId} that TrendPilot did not open; left untouched`, at });
      else if (lp.openOrderCount + lp.pendingOrderCount > 0)
        out.drift.push({ kind: 'STOP_ORPHANED', symbol: lp.symbol || String(lp.marketId), detail: `${lp.openOrderCount + lp.pendingOrderCount} order(s) rest on market ${lp.marketId} with no position; new Lighter entries on it are refused until they are gone`, at });
    }

    await db
      .update(exchangeConnections)
      .set({ accountState: accountStateOf(snap, now), drift: out.drift, lastSyncAt: now, lastSyncOkAt: now, lastSyncError: null, revision: sql`${exchangeConnections.revision} + 1`, updatedAt: sql`now()` })
      .where(eq(exchangeConnections.id, conn.id));
    if (out.drift.some((d) => d.kind !== 'STOP_ORPHANED')) await haltConnectionEntries(db, conn.ownerId, `LIGHTER_DRIFT: ${out.drift.map((d) => d.kind).join(',')}`, null, 'lighter-sync', 'LIGHTER');
    out.ok = true;
    return out;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await db.update(exchangeConnections).set({ lastSyncAt: now, lastSyncError: msg, updatedAt: sql`now()` }).where(eq(exchangeConnections.id, conn.id));
    return { ...out, error: msg };
  } finally {
    await db.update(exchangeConnections).set({ syncLeaseUntil: null }).where(eq(exchangeConnections.id, conn.id));
    if (conn.venueAccountIndex !== null) await scrubLighterSignerAccount(conn.venueAccountIndex).catch(() => undefined); // Key lifecycle
  }
}

type InstrumentRow = typeof instruments.$inferSelect;

/** The instrument's Lighter market rules (from the verified catalog import). */
export function lighterMarketOf(i: InstrumentRow) {
  return {
    marketId: i.exchangeMarketId!,
    symbol: i.exchangeSymbol ?? i.symbol,
    sizeDecimals: decimalsOfStep(i.qtyStep),
    priceDecimals: decimalsOfStep(i.priceTick),
    minBaseAmount: D(i.minQty).toFixed(),
    minQuoteAmount: D(i.minNotional ?? '0').toFixed(),
    maxQuoteAmount: i.maxNotional === null ? null : D(i.maxNotional).toFixed()
  };
}

/** The native stop's fills, when the stop filled at Lighter and is not booked yet. */
async function bookStopFill(db: Db, venue: ExecutionVenue, api: LighterApi, signer: LighterSigner, accountIndex: number, p: typeof positions.$inferSelect, now: Date): Promise<boolean> {
  const m = p.stopOrderRef ? /^lighter-sl:(\d+):(\d+)$/.exec(p.stopOrderRef) : null;
  if (!m) return false;
  const token = await signer.createAuthToken(Math.floor(now.getTime() / 1000) + 600);
  const [stop] = await api.ordersByClientIndex(accountIndex, [Number(m[2])], token);
  if (!stop || D(stop.filledBaseAmount).isZero()) return false;
  const trades = await api.tradesForOrder(accountIndex, stop.orderIndex, token);
  if (!trades.length || trades.some((t) => t.fee === null)) return false; // fills or fees not established: stays pending
  const qty = trades.reduce((t, x) => t.plus(x.size), D(0));
  const fill = {
    fillId: `lighter:${accountIndex}:${stop.orderIndex}`,
    contracts: qty.toFixed(),
    price: trades.reduce((t, x) => t.plus(D(x.price).times(x.size)), D(0)).div(qty).toDecimalPlaces(12).toFixed(),
    fee: trades.reduce((t, x) => t.plus(x.fee!), D(0)).toDecimalPlaces(8).toFixed(),
    filledAt: new Date(Math.max(...trades.map((t) => t.timestampMs)) || now.getTime())
  };
  const r = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(positions).where(eq(positions.id, p.id)).for('update');
    if (!locked || locked.status !== 'OPEN') return { recorded: false };
    return recordExitFill(db, tx, { position: locked, fill, reason: 'STOP_LOSS', intentId: null, now, venue });
  });
  return r.recorded;
}

/** A position Lighter no longer holds, with no fills listed: Closed, fill details pending. Once. */
async function closeFlatFillsPending(db: Db, p: typeof positions.$inferSelect, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(positions).where(eq(positions.id, p.id)).for('update');
    if (!locked || locked.status !== 'OPEN') return;
    await book(tx, { id: locked.paperAccountId, ownerId: locked.ownerId }, [
      { kind: 'POSITION_MARGIN_RELEASE', bucket: 'POSITION_MARGIN', amount: D(locked.marginUsdt).neg().toFixed(), refType: 'position', refId: `exchange-flat:${locked.id}`, memo: 'Margin released: closed on Lighter (fill details pending)' }
    ]);
    await tx
      .update(positions)
      .set({
        status: 'CLOSED',
        closeReason: 'EXTERNAL_CLOSE',
        closedAt: now,
        contracts: '0',
        quantity: '0',
        marginUsdt: '0',
        stopContracts: '0',
        protectionStatus: 'PENDING',
        protectionVerifiedAt: now,
        exchangeContracts: '0',
        exchangeCloseState: 'FILLS_PENDING',
        exchangePendingContracts: locked.contracts,
        exchangePendingReason: 'Closed on Lighter; fill details pending',
        exchangeFlatAt: now,
        exchangeSyncedAt: now,
        updatedAt: sql`now()`
      })
      .where(eq(positions.id, locked.id));
    await tx.update(positionTargets).set({ status: 'CANCELLED', updatedAt: sql`now()` }).where(and(eq(positionTargets.positionId, locked.id), ne(positionTargets.status, 'DONE')));
  });
}

function accountStateOf(s: LighterAccountSnapshot, now: Date) {
  return {
    currency: 'USDC',
    balance: { collateral: s.collateral, available: s.availableBalance, totalAssetValue: s.totalAssetValue, atMs: now.getTime(), source: 'SNAPSHOT' },
    tradingMode: s.tradingMode === 1 ? 'UNIFIED' : s.tradingMode === 0 ? 'CLASSIC' : null,
    positions: s.positions
      .filter((p) => p.side || p.openOrderCount + p.pendingOrderCount > 0)
      .map((p) => ({ marketId: p.marketId, symbol: p.symbol, side: p.side, size: p.size, avgEntryPrice: p.avgEntryPrice, liquidationPrice: p.liquidationPrice, unrealizedPnl: p.unrealizedPnl, fundingPaidOutUsdc: p.totalFundingPaidOut, marginMode: p.marginMode, openOrders: p.openOrderCount + p.pendingOrderCount }))
  };
}

/**
 * LIGHTER_STOP_RENEW_LEAD_HOURS: how long before a native stop expires TrendPilot treats it as due
 * (operator policy; unset = not configured, only expired stops are flagged). Proposed: 72.
 */
export function lighterStopRenewLeadMs(env: Record<string, string | undefined> = process.env): number | null {
  const v = env.LIGHTER_STOP_RENEW_LEAD_HOURS;
  return v && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 ? Number(v) * 3600_000 : null;
}

/**
 * Lighter connections the worker reconciles on its schedule (same rule as MEXC's
 * liveAccountsToSync): VERIFIED mainnet connections whose investor has Live switched on, or for
 * which TrendPilot manages exposure — open Live Lighter positions, unresolved orders or an
 * unconfirmed send. Testnet connections are never scheduled.
 */
export async function lighterConnectionsToSync(db: Db): Promise<string[]> {
  const conns = await db
    .select({ id: exchangeConnections.id, ownerId: exchangeConnections.ownerId, liveEnabled: exchangeConnections.liveEnabled })
    .from(exchangeConnections)
    .where(and(eq(exchangeConnections.exchange, 'LIGHTER'), eq(exchangeConnections.status, 'VERIFIED'), eq(exchangeConnections.venueEnvironment, 'MAINNET')));
  const out: string[] = [];
  for (const c of conns) {
    if (c.liveEnabled) {
      out.push(c.id);
      continue;
    }
    const x = await lighterExposure(db, c.ownerId, c.id);
    if (x.openPositions || x.unresolvedIntents || x.unresolvedTxs) out.push(c.id);
  }
  return out;
}

/**
 * The worker's scheduled Lighter reconciliation: the manual Sync service for each eligible
 * connection, one after another. Runs share the per-connection sync lease with manual Sync, so the
 * same account is never reconciled twice at once; fills are unique per Lighter order.
 */
export async function syncAllLighterConnections(db: Db, now: Date, o: { env?: Record<string, string | undefined> } = {}): Promise<LighterSyncSummary[]> {
  const out: LighterSyncSummary[] = [];
  for (const id of await lighterConnectionsToSync(db)) out.push(await syncLighterConnection(db, id, now, { env: o.env }));
  return out;
}

/** Unresolved Lighter sends (for operations views and the disconnect guard). */
export async function unresolvedLighterTxs(db: Db, connectionId: string) {
  return db.select().from(lighterTxs).where(and(eq(lighterTxs.connectionId, connectionId), inArray(lighterTxs.state, ['SENDING', 'UNKNOWN'])));
}
