import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { Decimal } from '@trendpilot/domain';
import type { Db, Executor } from '../client';
import { exchangeAccountEvents, exchangeConnections, exchangePositions } from '../schema';
import {
  readHistoryOrders,
  readHistoryPositions,
  readHistoryTrades,
  readPendingPositions,
  takeBitunixSnapshot,
  type BitunixHistoryPosition,
  type BitunixPosition,
  type BitunixSnapshot,
  type Origin
} from './bitunixAccount';
import { BitunixPrivateError, type BitunixRequester } from './bitunixPrivate';
import type { BitunixPrivateEvent } from './bitunixPrivateWs';
import type { ConnectionRow } from './liveMode';

/**
 * Bitunix account reconciliation (Step 2, read-only). Mirrors the investor's Bitunix MAIN account
 * into `exchange_positions` (one row per Bitunix positionId, so a symbol's LONG and SHORT legs
 * coexist) and records every exchange-reported change in `exchange_account_events`
 * (deduplicated per connection). Nothing here touches Paper or the MEXC Live account.
 *
 * Ordering. Each position row keeps the exchange time of the state it holds (`exchange_updated_at`:
 * REST `mtime`; for WebSocket position pushes, which carry no modify time, the gateway `ts`).
 * An update older than that is ignored, so a late or replayed event never overwrites newer state.
 * Duplicate events collapse on their dedup key.
 *
 * Closes. A position is CLOSED only when Bitunix's position HISTORY returns it (with its close
 * price, time and settled fee/funding). A missing row in a complete snapshot, a `CLOSE` push or a
 * zero quantity only marks it "close pending confirmation"; a failed or incomplete snapshot changes
 * nothing. A tpsl `CLOSE`+`FILLED` push means Bitunix PLACED the triggered child order; execution is
 * confirmed separately from fills and the remaining position quantity.
 *
 * Origin. TrendPilot places no Bitunix orders in this release, so position changes are recorded as
 * EXCHANGE-originated; orders and fills are classified by client ID (`tp-…` / `tpx-…` = TrendPilot).
 * Fees and funding are stored only as Bitunix reports them; a settlement amount Bitunix has not
 * reported stays null (unknown), never computed.
 */

export const BITUNIX_SYNC_LEASE_SECONDS = 120;
/** First history window for fills / orders when a connection has never synced them. */
export const BITUNIX_HISTORY_LOOKBACK_MS = 24 * 3_600_000;
/** Overlap with the previous window, so a fill recorded late by the exchange is still read. */
const HISTORY_OVERLAP_MS = 5 * 60_000;
const D = (v: Decimal.Value) => new Decimal(v);

type PositionRow = typeof exchangePositions.$inferSelect;
export type EventSource = 'REST' | 'WS' | 'HISTORY';

export interface AccountState {
  balance?: { coin: 'USDT'; available: string | null; frozen: string | null; margin: string | null; unrealized?: string | null; equity?: string | null; atMs: number; source: 'REST' | 'WS' };
  positionMode?: string | null;
  pendingOrders?: unknown[];
  tpsl?: unknown[];
  snapshotAtMs?: number;
  excludedSubAccountRows?: number;
  /** Fills and orders are read up to here (exchange ms). */
  historySyncedToMs?: number;
}

export interface BitunixSyncResult {
  connectionId: string;
  ownerId: string;
  ok: boolean;
  busy?: boolean;
  error?: string;
  positionsOpen: number;
  opened: number;
  reduced: number;
  increased: number;
  closed: number;
  closePending: number;
  events: number;
  tpslConfirmed: number;
  excludedSubAccountRows: number;
}

/* ───────────────────────── Event log ───────────────────────── */

export interface NewEvent {
  kind: string;
  dedupKey: string;
  origin: Origin;
  source: EventSource;
  exchangePositionId?: string | null;
  exchangeOrderId?: string | null;
  symbol?: string | null;
  side?: string | null;
  qtyBefore?: string | null;
  qtyAfter?: string | null;
  businessTimeMs?: number | null;
  detail?: Record<string, unknown>;
}

/** Inserts the event unless its dedup key exists for this connection. Returns whether it was new. */
export async function recordAccountEvent(tx: Executor, conn: Pick<ConnectionRow, 'id' | 'ownerId' | 'exchange'>, e: NewEvent): Promise<boolean> {
  const rows = await tx
    .insert(exchangeAccountEvents)
    .values({
      connectionId: conn.id,
      ownerId: conn.ownerId,
      exchange: conn.exchange,
      kind: e.kind,
      dedupKey: e.dedupKey.slice(0, 300),
      origin: e.origin,
      source: e.source,
      exchangePositionId: e.exchangePositionId ?? null,
      exchangeOrderId: e.exchangeOrderId ?? null,
      symbol: e.symbol ?? null,
      side: e.side ?? null,
      qtyBefore: e.qtyBefore ?? null,
      qtyAfter: e.qtyAfter ?? null,
      businessTime: e.businessTimeMs ? new Date(e.businessTimeMs) : null,
      detail: e.detail ?? {}
    })
    .onConflictDoNothing({ target: [exchangeAccountEvents.connectionId, exchangeAccountEvents.dedupKey] })
    .returning({ id: exchangeAccountEvents.id });
  return rows.length > 0;
}

/* ───────────────────────── Positions ───────────────────────── */

async function positionRow(tx: Executor, connectionId: string, positionId: string): Promise<PositionRow | null> {
  const [p] = await tx
    .select()
    .from(exchangePositions)
    .where(and(eq(exchangePositions.connectionId, connectionId), eq(exchangePositions.exchangePositionId, positionId)))
    .for('update');
  return p ?? null;
}

export type UpsertOutcome = 'OPENED' | 'INCREASED' | 'REDUCED' | 'UNCHANGED' | 'STALE' | 'ZERO' | 'REOPENED';

interface PositionInput {
  positionId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: string;
  avgOpenPrice?: string | null;
  positionMode?: string | null;
  marginMode?: string | null;
  leverage?: number | null;
  margin?: string | null;
  unrealizedPNL?: string | null;
  realizedPNL?: string | null;
  fee?: string | null;
  funding?: string | null;
  liqPrice?: string | null;
  ctimeMs?: number | null;
}

/**
 * Applies an open-position state Bitunix reported at `timeMs`. Never closes a position: a zero
 * quantity becomes a close-pending check (outcome ZERO) for the caller to confirm.
 */
export async function upsertPosition(tx: Executor, conn: Pick<ConnectionRow, 'id' | 'ownerId' | 'exchange'>, p: PositionInput, timeMs: number, source: EventSource): Promise<UpsertOutcome> {
  const existing = await positionRow(tx, conn.id, p.positionId);
  if (existing?.exchangeUpdatedAt && timeMs < existing.exchangeUpdatedAt.getTime()) return 'STALE';
  const qty = D(p.qty);
  const fields = {
    symbol: p.symbol,
    side: p.side,
    ...(p.positionMode !== undefined ? { positionMode: p.positionMode } : {}),
    ...(p.marginMode !== undefined ? { marginMode: p.marginMode } : {}),
    ...(p.leverage !== undefined && p.leverage !== null ? { leverage: p.leverage } : {}),
    ...(p.avgOpenPrice !== undefined && p.avgOpenPrice !== null ? { avgOpenPrice: p.avgOpenPrice } : {}),
    ...(p.margin !== undefined ? { margin: p.margin } : {}),
    ...(p.unrealizedPNL !== undefined ? { unrealizedPnl: p.unrealizedPNL } : {}),
    ...(p.realizedPNL !== undefined ? { realizedPnl: p.realizedPNL } : {}),
    ...(p.fee !== undefined ? { reportedFee: p.fee } : {}),
    ...(p.funding !== undefined ? { reportedFunding: p.funding } : {}),
    ...(p.liqPrice !== undefined ? { liqPrice: p.liqPrice } : {}),
    exchangeUpdatedAt: new Date(timeMs),
    lastSource: source,
    updatedAt: sql`now()`
  };
  if (!existing) {
    if (qty.lte(0)) return 'ZERO';
    await tx.insert(exchangePositions).values({
      connectionId: conn.id,
      ownerId: conn.ownerId,
      exchange: conn.exchange,
      exchangePositionId: p.positionId,
      qty: qty.toFixed(),
      maxQty: qty.toFixed(),
      status: 'OPEN',
      origin: 'EXCHANGE',
      openedAt: p.ctimeMs ? new Date(p.ctimeMs) : new Date(timeMs),
      ...fields
    });
    await recordAccountEvent(tx, conn, { kind: 'POSITION_OPENED', dedupKey: `open:${p.positionId}`, origin: 'EXCHANGE', source, exchangePositionId: p.positionId, symbol: p.symbol, side: p.side, qtyBefore: '0', qtyAfter: qty.toFixed(), businessTimeMs: p.ctimeMs ?? timeMs });
    return 'OPENED';
  }
  if (qty.lte(0)) {
    await markClosePending(tx, conn, existing, `Bitunix reported quantity 0 (${source})`, source, timeMs);
    return 'ZERO';
  }
  const before = D(existing.qty);
  const reopened = existing.status === 'CLOSED';
  await tx
    .update(exchangePositions)
    .set({
      ...fields,
      qty: qty.toFixed(),
      maxQty: Decimal.max(qty, existing.maxQty ?? 0).toFixed(),
      status: 'OPEN',
      closeCheck: 'NONE',
      closeCheckSince: null,
      closeCheckReason: null,
      ...(reopened ? { closedAt: null, closePrice: null, settledFee: null, settledFunding: null, settledRealizedPnl: null } : {}),
      revision: sql`${exchangePositions.revision} + 1`
    })
    .where(eq(exchangePositions.id, existing.id));
  const base = { origin: 'EXCHANGE' as const, source, exchangePositionId: p.positionId, symbol: p.symbol, side: p.side, qtyBefore: before.toFixed(), qtyAfter: qty.toFixed(), businessTimeMs: timeMs };
  if (reopened) {
    await recordAccountEvent(tx, conn, { ...base, kind: 'POSITION_REOPENED', dedupKey: `reopen:${p.positionId}:${timeMs}` });
    return 'REOPENED';
  }
  if (qty.lt(before)) {
    // A partial close made on Bitunix (manual, TP/SL child or liquidation): the remaining size is exact.
    await recordAccountEvent(tx, conn, { ...base, kind: 'POSITION_REDUCED', dedupKey: `qty:${p.positionId}:${before.toFixed()}>${qty.toFixed()}@${timeMs}`, detail: { closedQty: before.minus(qty).toFixed(), partial: true } });
    return 'REDUCED';
  }
  if (qty.gt(before)) {
    await recordAccountEvent(tx, conn, { ...base, kind: 'POSITION_INCREASED', dedupKey: `qty:${p.positionId}:${before.toFixed()}>${qty.toFixed()}@${timeMs}` });
    return 'INCREASED';
  }
  return 'UNCHANGED';
}

/** Flags an OPEN position as possibly closed. It stays OPEN until Bitunix history confirms the close. */
export async function markClosePending(tx: Executor, conn: Pick<ConnectionRow, 'id' | 'ownerId' | 'exchange'>, pos: PositionRow, reason: string, source: EventSource, timeMs: number): Promise<void> {
  if (pos.status !== 'OPEN') return;
  if (pos.closeCheck !== 'PENDING') {
    await tx
      .update(exchangePositions)
      .set({ closeCheck: 'PENDING', closeCheckSince: new Date(), closeCheckReason: reason.slice(0, 200), updatedAt: sql`now()`, revision: sql`${exchangePositions.revision} + 1` })
      .where(eq(exchangePositions.id, pos.id));
  }
  await recordAccountEvent(tx, conn, {
    kind: 'POSITION_CLOSE_SUSPECTED',
    dedupKey: `suspect:${pos.exchangePositionId}:${pos.qty}:${source}`,
    origin: 'EXCHANGE',
    source,
    exchangePositionId: pos.exchangePositionId,
    symbol: pos.symbol,
    side: pos.side,
    qtyBefore: pos.qty,
    businessTimeMs: timeMs,
    detail: { reason, confirmation: 'pending: Bitunix position history must show the close' }
  });
}

/** Records the confirmed close from a Bitunix position-history row. */
async function closeFromHistory(tx: Executor, conn: Pick<ConnectionRow, 'id' | 'ownerId' | 'exchange'>, pos: PositionRow, h: BitunixHistoryPosition): Promise<void> {
  const closedAtMs = h.mtimeMs ?? Date.now();
  await tx
    .update(exchangePositions)
    .set({
      status: 'CLOSED',
      qty: '0',
      closeCheck: 'NONE',
      closeCheckSince: null,
      closeCheckReason: null,
      closedAt: new Date(closedAtMs),
      closePrice: h.closePrice,
      // Settlement amounts exactly as Bitunix's history reports them; null stays unknown.
      settledFee: h.fee,
      settledFunding: h.funding,
      settledRealizedPnl: h.realizedPNL,
      exchangeUpdatedAt: new Date(Math.max(closedAtMs, pos.exchangeUpdatedAt?.getTime() ?? 0)),
      lastSource: 'HISTORY',
      updatedAt: sql`now()`,
      revision: sql`${exchangePositions.revision} + 1`
    })
    .where(eq(exchangePositions.id, pos.id));
  await recordAccountEvent(tx, conn, {
    kind: 'POSITION_CLOSED',
    dedupKey: `close:${pos.exchangePositionId}`,
    origin: 'EXCHANGE',
    source: 'HISTORY',
    exchangePositionId: pos.exchangePositionId,
    symbol: pos.symbol,
    side: pos.side,
    qtyBefore: pos.qty,
    qtyAfter: '0',
    businessTimeMs: closedAtMs,
    detail: { closePrice: h.closePrice, maxQty: h.maxQty, liqQty: h.liqQty, liquidated: h.liqQty !== null && D(h.liqQty).gt(0), fee: h.fee, funding: h.funding, realizedPNL: h.realizedPNL, confirmedBy: 'get_history_positions' }
  });
}

/**
 * Confirms (or clears) a pending close with two reads: the open-position list for that ID, then
 * position history. Neither answering → it stays pending; an error → it stays pending.
 */
export async function confirmPendingClose(db: Db, conn: Pick<ConnectionRow, 'id' | 'ownerId' | 'exchange'>, r: BitunixRequester, pos: PositionRow): Promise<'CLOSED' | 'STILL_OPEN' | 'PENDING'> {
  const open = (await readPendingPositions(r, { positionId: pos.exchangePositionId, symbol: pos.symbol })).items.find((p) => p.positionId === pos.exchangePositionId);
  if (open && D(open.qty).gt(0)) {
    await db.transaction((tx) => upsertPosition(tx, conn, open, Math.max(open.mtimeMs ?? 0, pos.exchangeUpdatedAt?.getTime() ?? 0), 'REST'));
    return 'STILL_OPEN';
  }
  const hist = (await readHistoryPositions(r, { positionId: pos.exchangePositionId, symbol: pos.symbol }, { maxPages: 5 })).items.find((h) => h.positionId === pos.exchangePositionId);
  if (!hist) return 'PENDING';
  await db.transaction(async (tx) => {
    const cur = await positionRow(tx, conn.id, pos.exchangePositionId);
    if (cur && cur.status === 'OPEN') await closeFromHistory(tx, conn, cur, hist);
  });
  return 'CLOSED';
}

/* ───────────────────────── Snapshot ───────────────────────── */

/** Applies a COMPLETE snapshot in one transaction. Missing positions become close-pending, never closed. */
export async function applyBitunixSnapshot(db: Db, conn: ConnectionRow, s: BitunixSnapshot, out: BitunixSyncResult): Promise<void> {
  await db.transaction(async (tx) => {
    const seen = new Set<string>();
    for (const p of s.positions) {
      seen.add(p.positionId);
      const o = await upsertPosition(tx, conn, p, p.mtimeMs ?? s.takenAt, 'REST');
      if (o === 'OPENED') out.opened += 1;
      if (o === 'REDUCED') out.reduced += 1;
      if (o === 'INCREASED') out.increased += 1;
    }
    const stored = await tx
      .select()
      .from(exchangePositions)
      .where(and(eq(exchangePositions.connectionId, conn.id), eq(exchangePositions.status, 'OPEN')))
      .for('update');
    for (const pos of stored) {
      // A row updated after the snapshot was taken (a newer push) is not judged by this snapshot.
      if (!seen.has(pos.exchangePositionId) && !(pos.exchangeUpdatedAt && pos.exchangeUpdatedAt.getTime() > s.takenAt)) {
        await markClosePending(tx, conn, pos, 'absent from a complete Bitunix snapshot', 'REST', s.takenAt);
      }
    }
    if (s.positionMode !== conn.positionMode) {
      await recordAccountEvent(tx, conn, { kind: 'POSITION_MODE_REPORTED', dedupKey: `mode:${s.positionMode}:${s.takenAt}`, origin: 'EXCHANGE', source: 'REST', businessTimeMs: s.takenAt, detail: { before: conn.positionMode, after: s.positionMode } });
    }
    const prev = (conn.accountState ?? {}) as AccountState;
    const wsNewer = prev.balance?.source === 'WS' && prev.balance.atMs > s.takenAt;
    const state: AccountState = {
      ...prev,
      positionMode: s.positionMode,
      balance: wsNewer || !s.usdt
        ? prev.balance
        : {
            coin: 'USDT',
            available: s.usdt.available,
            frozen: s.usdt.frozen,
            margin: s.usdt.margin,
            unrealized: D(s.usdt.crossUnrealizedPNL).plus(s.usdt.isolationUnrealizedPNL).toFixed(),
            equity: D(s.usdt.available).plus(s.usdt.frozen).plus(s.usdt.margin).plus(s.usdt.crossUnrealizedPNL).plus(s.usdt.isolationUnrealizedPNL).toFixed(),
            atMs: s.takenAt,
            source: 'REST'
          },
      pendingOrders: s.pendingOrders.slice(0, 200),
      tpsl: s.tpsl.slice(0, 200),
      snapshotAtMs: s.takenAt,
      excludedSubAccountRows: s.excludedSubAccountRows
    };
    await tx.update(exchangeConnections).set({ positionMode: s.positionMode, accountState: state, updatedAt: sql`now()` }).where(eq(exchangeConnections.id, conn.id));
  });
}

/* ───────────────────────── History: fills, orders, TP/SL execution ───────────────────────── */

async function syncHistory(db: Db, conn: ConnectionRow, r: BitunixRequester, nowMs: number, out: BitunixSyncResult): Promise<void> {
  const [fresh] = await db.select({ s: exchangeConnections.accountState }).from(exchangeConnections).where(eq(exchangeConnections.id, conn.id));
  const state = (fresh?.s ?? {}) as AccountState;
  const from = Math.max(0, (state.historySyncedToMs ?? nowMs - BITUNIX_HISTORY_LOOKBACK_MS) - HISTORY_OVERLAP_MS);
  const trades = await readHistoryTrades(r, { startTime: from, endTime: nowMs });
  const orders = await readHistoryOrders(r, { startTime: from, endTime: nowMs });
  await db.transaction(async (tx) => {
    for (const t of trades.items) {
      if (
        await recordAccountEvent(tx, conn, {
          kind: 'FILL',
          dedupKey: `fill:${t.tradeId}`,
          origin: t.origin,
          source: 'HISTORY',
          exchangeOrderId: t.orderId,
          symbol: t.symbol,
          side: t.side,
          businessTimeMs: t.ctimeMs,
          detail: { tradeId: t.tradeId, qty: t.qty, price: t.price, fee: t.fee, realizedPNL: t.realizedPNL, reduceOnly: t.reduceOnly, roleType: t.roleType, clientId: t.clientId }
        })
      )
        out.events += 1;
    }
    for (const o of orders.items) {
      if (
        await recordAccountEvent(tx, conn, {
          kind: 'ORDER',
          dedupKey: `order:${o.orderId}:${o.status}:${o.tradeQty ?? ''}`,
          origin: o.origin,
          source: 'HISTORY',
          exchangeOrderId: o.orderId,
          symbol: o.symbol,
          side: o.side,
          businessTimeMs: o.mtimeMs ?? o.ctimeMs,
          detail: { status: o.status, type: o.orderType, qty: o.qty, tradeQty: o.tradeQty, price: o.price, reduceOnly: o.reduceOnly, fee: o.fee, clientId: o.clientId }
        })
      )
        out.events += 1;
    }
    // The window is complete (every page read): move the watermark.
    await tx
      .update(exchangeConnections)
      .set({ accountState: sql`${exchangeConnections.accountState} || ${JSON.stringify({ historySyncedToMs: nowMs })}::jsonb` })
      .where(eq(exchangeConnections.id, conn.id));
  });
}

/**
 * A tpsl CLOSE+FILLED push only says the child order was PLACED. Execution is confirmed from fills
 * on that position since the trigger, plus the remaining position quantity. Without fills the
 * trigger stays "child order not filled yet" and nothing about the position changes.
 */
async function confirmTriggeredTpsl(db: Db, conn: ConnectionRow, r: BitunixRequester, out: BitunixSyncResult): Promise<void> {
  const pending = await db
    .select()
    .from(exchangeAccountEvents)
    .where(and(eq(exchangeAccountEvents.connectionId, conn.id), eq(exchangeAccountEvents.kind, 'TPSL_TRIGGERED'), sql`${exchangeAccountEvents.detail}->>'execution' = 'PENDING'`))
    .orderBy(asc(exchangeAccountEvents.createdAt))
    .limit(20);
  for (const ev of pending) {
    if (!ev.exchangePositionId) continue;
    const since = (ev.businessTime?.getTime() ?? ev.createdAt.getTime()) - 1_000;
    const fills = (await readHistoryTrades(r, { positionId: ev.exchangePositionId, startTime: since }, { maxPages: 5 })).items.filter((t) => (t.ctimeMs ?? 0) >= since);
    const [pos] = await db.select().from(exchangePositions).where(and(eq(exchangePositions.connectionId, conn.id), eq(exchangePositions.exchangePositionId, ev.exchangePositionId)));
    const checkedAt = new Date().toISOString();
    if (!fills.length) {
      await db
        .update(exchangeAccountEvents)
        .set({ detail: sql`${exchangeAccountEvents.detail} || ${JSON.stringify({ lastCheckedAt: checkedAt, childOrder: 'placed by Bitunix; no fill yet' })}::jsonb` })
        .where(eq(exchangeAccountEvents.id, ev.id));
      continue;
    }
    const filledQty = fills.reduce((a, t) => a.plus(t.qty), D(0)).toFixed();
    await db.transaction(async (tx) => {
      await tx
        .update(exchangeAccountEvents)
        .set({ detail: sql`${exchangeAccountEvents.detail} || ${JSON.stringify({ execution: 'FILLED', lastCheckedAt: checkedAt, filledQty, tradeIds: fills.map((t) => t.tradeId) })}::jsonb` })
        .where(eq(exchangeAccountEvents.id, ev.id));
      await recordAccountEvent(tx, conn, {
        kind: 'TPSL_EXECUTED',
        dedupKey: `tpsl-exec:${ev.exchangeOrderId}`,
        origin: 'EXCHANGE',
        source: 'HISTORY',
        exchangePositionId: ev.exchangePositionId,
        exchangeOrderId: ev.exchangeOrderId,
        symbol: ev.symbol,
        side: pos?.side ?? null,
        qtyAfter: pos?.qty ?? null,
        businessTimeMs: Math.max(...fills.map((t) => t.ctimeMs ?? 0)),
        detail: { filledQty, tradeIds: fills.map((t) => t.tradeId), fees: fills.map((t) => t.fee), remainingPositionQty: pos?.status === 'OPEN' ? pos.qty : '0' }
      });
    });
    out.tpslConfirmed += 1;
  }
}

/* ───────────────────────── WebSocket events ───────────────────────── */

/** What applying a push asks the caller to do next. */
export interface ApplyOutcome {
  applied: boolean;
  /** Something needs a REST read to confirm (a close, a TP/SL execution, a fill). */
  needsSync: boolean;
  stale?: boolean;
}

const TPSL_KIND: Record<string, string> = {
  'CREATE:NEW': 'TPSL_CREATED',
  'UPDATE:NEW': 'TPSL_UPDATED',
  'CLOSE:CANCELED': 'TPSL_CANCELED',
  'CLOSE:SYSTEM_CANCELED': 'TPSL_SYSTEM_CANCELED',
  'CLOSE:FILLED': 'TPSL_TRIGGERED',
  'CLOSE:FAILED': 'TPSL_FAILED'
};

/** Applies one private push for this connection. Idempotent; older-than-stored state is ignored. */
export async function applyBitunixEvent(db: Db, conn: ConnectionRow, e: BitunixPrivateEvent): Promise<ApplyOutcome> {
  const timeMs = e.tsMs ?? e.receivedAt.getTime();
  switch (e.channel) {
    case 'position':
      return db.transaction(async (tx) => {
        const closing = e.event === 'CLOSE' || (e.qty !== null && D(e.qty).lte(0));
        if (closing) {
          const pos = await positionRow(tx, conn.id, e.positionId);
          if (pos?.exchangeUpdatedAt && timeMs < pos.exchangeUpdatedAt.getTime()) return { applied: false, needsSync: false, stale: true };
          if (pos && pos.status === 'OPEN') {
            await tx.update(exchangePositions).set({ exchangeUpdatedAt: new Date(timeMs), lastSource: 'WS' }).where(eq(exchangePositions.id, pos.id));
            await markClosePending(tx, conn, pos, `Bitunix pushed position ${e.event}${e.qty !== null ? ` qty ${e.qty}` : ''}`, 'WS', timeMs);
          }
          return { applied: !!pos, needsSync: true };
        }
        if (e.qty === null) return { applied: false, needsSync: true };
        const o = await upsertPosition(tx, conn, { ...e, qty: e.qty }, timeMs, 'WS');
        return { applied: o !== 'STALE' && o !== 'UNCHANGED', needsSync: o === 'REDUCED' || o === 'OPENED', stale: o === 'STALE' };
      });
    case 'order': {
      const t = e.mtimeMs ?? e.ctimeMs ?? timeMs;
      const fresh = await recordAccountEvent(db, conn, {
        kind: 'ORDER',
        dedupKey: `order:${e.orderId}:${e.status}:${e.dealAmount ?? ''}`,
        origin: e.origin,
        source: 'WS',
        exchangeOrderId: e.orderId,
        symbol: e.symbol,
        side: e.side,
        businessTimeMs: t,
        detail: { event: e.event, status: e.status, type: e.type, qty: e.qty, dealAmount: e.dealAmount, averagePrice: e.averagePrice, fee: e.fee, clientId: e.clientId }
      });
      return { applied: fresh, needsSync: fresh && (e.status === 'FILLED' || e.status === 'PART_FILLED' || e.status === 'PART_FILLED_CANCELED') };
    }
    case 'balance': {
      if (e.coin !== 'USDT') return { applied: false, needsSync: false };
      // Only a newer balance replaces the stored one (REST snapshot time vs push time, both exchange ms).
      const rows = await db
        .update(exchangeConnections)
        .set({
          accountState: sql`jsonb_set(${exchangeConnections.accountState}, '{balance}', ${JSON.stringify({ coin: 'USDT', available: e.available, frozen: e.frozen, margin: e.margin, atMs: timeMs, source: 'WS' })}::jsonb, true)`,
          updatedAt: sql`now()`
        })
        .where(and(eq(exchangeConnections.id, conn.id), sql`coalesce((${exchangeConnections.accountState}->'balance'->>'atMs')::bigint, 0) <= ${timeMs}`))
        .returning({ id: exchangeConnections.id });
      return { applied: rows.length > 0, needsSync: false, stale: rows.length === 0 };
    }
    case 'tpsl': {
      const kind = TPSL_KIND[`${e.event}:${e.status}`] ?? 'TPSL_EVENT';
      const fresh = await recordAccountEvent(db, conn, {
        kind,
        dedupKey: `tpsl:${e.orderId}:${e.event}:${e.status}`,
        origin: 'EXCHANGE',
        source: 'WS',
        exchangePositionId: e.positionId,
        exchangeOrderId: e.orderId,
        symbol: e.symbol,
        side: e.side,
        businessTimeMs: e.ctimeMs ?? timeMs,
        detail: {
          event: e.event,
          status: e.status,
          tpPrice: e.tpPrice,
          slPrice: e.slPrice,
          tpQty: e.tpQty,
          slQty: e.slQty,
          ...(kind === 'TPSL_TRIGGERED' ? { execution: 'PENDING', childOrder: 'placed by Bitunix; execution not confirmed' } : {})
        }
      });
      return { applied: fresh, needsSync: fresh && kind === 'TPSL_TRIGGERED' };
    }
  }
}

/* ───────────────────────── Sync run ───────────────────────── */

const emptyResult = (conn: Pick<ConnectionRow, 'id' | 'ownerId'>): BitunixSyncResult => ({
  connectionId: conn.id,
  ownerId: conn.ownerId,
  ok: false,
  positionsOpen: 0,
  opened: 0,
  reduced: 0,
  increased: 0,
  closed: 0,
  closePending: 0,
  events: 0,
  tpslConfirmed: 0,
  excludedSubAccountRows: 0
});

const errorText = (e: unknown) => (e instanceof BitunixPrivateError ? `${e.kind}${e.code !== undefined ? ` ${e.code}` : ''}: ${e.message}` : (e as Error)?.message ?? 'sync failed').slice(0, 300);

/**
 * One read-only reconciliation of a Bitunix connection: complete snapshot → positions, balance,
 * pending orders and TP/SL; pending closes confirmed against history; fills and orders since the
 * last window; triggered TP/SL execution checks. One run per connection at a time (lease).
 */
export async function syncBitunixConnection(db: Db, connectionId: string, r: BitunixRequester, opts: { now?: () => Date } = {}): Promise<BitunixSyncResult> {
  const now = opts.now ?? (() => new Date());
  const [conn] = await db.select().from(exchangeConnections).where(eq(exchangeConnections.id, connectionId));
  if (!conn) return { ...emptyResult({ id: connectionId, ownerId: '' }), error: 'no connection' };
  const out = emptyResult(conn);
  if (conn.exchange !== 'BITUNIX') return { ...out, error: 'not a Bitunix connection' };
  if (conn.status !== 'VERIFIED' || !conn.apiKeySealed) return { ...out, error: `connection is ${conn.status}` };
  const [lease] = await db
    .update(exchangeConnections)
    .set({ syncLeaseUntil: sql`now() + make_interval(secs => ${BITUNIX_SYNC_LEASE_SECONDS})` })
    .where(and(eq(exchangeConnections.id, conn.id), sql`(${exchangeConnections.syncLeaseUntil} IS NULL OR ${exchangeConnections.syncLeaseUntil} < now())`))
    .returning({ id: exchangeConnections.id });
  if (!lease) return { ...out, busy: true, error: 'a sync is already running for this connection' };
  const at = now();
  try {
    const snap = await takeBitunixSnapshot(r, () => now().getTime());
    out.excludedSubAccountRows = snap.excludedSubAccountRows;
    await applyBitunixSnapshot(db, conn, snap, out);
    const pending = await db.select().from(exchangePositions).where(and(eq(exchangePositions.connectionId, conn.id), eq(exchangePositions.status, 'OPEN'), eq(exchangePositions.closeCheck, 'PENDING')));
    for (const p of pending) {
      const c = await confirmPendingClose(db, conn, r, p);
      if (c === 'CLOSED') out.closed += 1;
    }
    await syncHistory(db, conn, r, snap.takenAt, out);
    await confirmTriggeredTpsl(db, conn, r, out);
    const open = await db.select({ id: exchangePositions.id, closeCheck: exchangePositions.closeCheck }).from(exchangePositions).where(and(eq(exchangePositions.connectionId, conn.id), eq(exchangePositions.status, 'OPEN')));
    out.positionsOpen = open.length;
    out.closePending = open.filter((p) => p.closeCheck === 'PENDING').length;
    out.ok = true;
    await db.update(exchangeConnections).set({ lastSyncAt: at, lastSyncOkAt: at, lastSyncError: null, syncLeaseUntil: null, updatedAt: sql`now()` }).where(eq(exchangeConnections.id, conn.id));
    return out;
  } catch (e) {
    const msg = errorText(e);
    // Positions keep their last confirmed state: a failed or incomplete read closes nothing.
    await db.update(exchangeConnections).set({ lastSyncAt: at, lastSyncError: msg, syncLeaseUntil: null, updatedAt: sql`now()` }).where(eq(exchangeConnections.id, conn.id));
    return { ...out, error: msg };
  }
}

/* ───────────────────────── Read model ───────────────────────── */

export interface BitunixAccountView {
  accountState: AccountState;
  streamState: Record<string, unknown>;
  lastSyncAt: string | null;
  lastSyncOkAt: string | null;
  lastSyncError: string | null;
  positions: {
    positionId: string;
    symbol: string;
    side: string;
    qty: string;
    avgOpenPrice: string | null;
    leverage: number | null;
    liqPrice: string | null;
    unrealizedPnl: string | null;
    status: string;
    closeCheck: string;
    closePrice: string | null;
    closedAt: string | null;
    origin: string;
    updatedAt: string | null;
  }[];
  recentEvents: { kind: string; origin: string; source: string; symbol: string | null; side: string | null; qtyBefore: string | null; qtyAfter: string | null; at: string; detail: unknown }[];
}

/** The connection owner's Bitunix account as TrendPilot mirrors it (owner-scoped by the caller). */
export async function bitunixAccountView(db: Executor, conn: ConnectionRow): Promise<BitunixAccountView> {
  const positions = await db
    .select()
    .from(exchangePositions)
    .where(eq(exchangePositions.connectionId, conn.id))
    .orderBy(asc(exchangePositions.status), desc(exchangePositions.updatedAt))
    .limit(50);
  const events = await db.select().from(exchangeAccountEvents).where(eq(exchangeAccountEvents.connectionId, conn.id)).orderBy(desc(exchangeAccountEvents.createdAt)).limit(30);
  return {
    accountState: (conn.accountState ?? {}) as AccountState,
    streamState: (conn.streamState ?? {}) as Record<string, unknown>,
    lastSyncAt: conn.lastSyncAt?.toISOString() ?? null,
    lastSyncOkAt: conn.lastSyncOkAt?.toISOString() ?? null,
    lastSyncError: conn.lastSyncError,
    positions: positions.map((p) => ({
      positionId: p.exchangePositionId,
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      avgOpenPrice: p.avgOpenPrice,
      leverage: p.leverage,
      liqPrice: p.liqPrice,
      unrealizedPnl: p.unrealizedPnl,
      status: p.status,
      closeCheck: p.closeCheck,
      closePrice: p.closePrice,
      closedAt: p.closedAt?.toISOString() ?? null,
      origin: p.origin,
      updatedAt: p.exchangeUpdatedAt?.toISOString() ?? null
    })),
    recentEvents: events.map((e) => ({ kind: e.kind, origin: e.origin, source: e.source, symbol: e.symbol, side: e.side, qtyBefore: e.qtyBefore, qtyAfter: e.qtyAfter, at: (e.businessTime ?? e.createdAt).toISOString(), detail: e.detail }))
  };
}

export type { BitunixPosition };
