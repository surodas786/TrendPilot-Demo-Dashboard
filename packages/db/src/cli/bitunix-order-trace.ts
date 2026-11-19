/**
 * Trace (and, with --apply, recover) ONE TrendPilot Bitunix Live entry through the signal event,
 * entry decision, intent, reservation, submit job, sanitized Bitunix request/response, private
 * WebSocket deliveries and Bitunix's own records, using the investor's stored connection.
 *
 *   npm run ops:bitunix-order-trace -- --ref e6d08d8e7da84c0696edd8ae89a435c3
 *   npm run ops:bitunix-order-trace -- --ref e6d08d8e7da84c0696edd8ae89a435c3 --apply
 *
 * `--ref` may be the client order ID shown in My Trades, the intent UUID or a Bitunix order ID;
 * the trace prints which one it matched and the persisted client ID it then uses.
 *
 * Without --apply: database reads in one READ ONLY transaction, Bitunix through the read-only
 * transport (allowlisted GETs; it cannot place, change or cancel an order), and a DRY RUN of the
 * reconciliation that says what it would book or release. Nothing is written.
 * With --apply: the same reconciliation the worker's sync runs (reconcileBitunixIntents) for this
 * one client ID: a final Bitunix order is booked (fills, position, stop) exactly once; confirmed
 * absence expires the intent and releases its reservation atomically; anything else stays
 * unresolved. Still no order request is ever sent. Keys, secrets and signatures are never printed.
 */
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { exchangeAccountEvents, exchangeConnections, instruments, jobs, ledgerEntries, orderIntents, paperAccounts, serviceHeartbeats, signalDecisions, signalEvents, users } from '../schema';
import { readHistoryOrders, readHistoryPositions, readHistoryTrades, readPendingOrders, readPendingPositions, readPendingTpsl } from '../live/bitunixAccount';
import { bitunixRequesterFor } from '../live/bitunixConnection';
import { reconcileBitunixIntents } from '../live/bitunixIntents';
import type { BitunixRequester } from '../live/bitunixPrivate';
import { PAPER_SUBMIT_JOB } from '../paper/entry';

loadRootEnv();
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const ref = (arg('ref') ?? arg('client-id') ?? '').trim();
const apply = process.argv.includes('--apply');
if (!ref) {
  console.error('usage: npm run ops:bitunix-order-trace -- --ref <clientOrderId | intent id | Bitunix orderId> [--apply]');
  process.exit(2);
}
const tz = 'Asia/Dhaka';
const local = (d: Date | string | null | undefined) => (d ? `${new Date(d).toISOString()} (${new Date(d).toLocaleString('en-GB', { timeZone: tz })} BDT)` : null);
const show = (title: string, v: unknown) => console.log(`\n## ${title}\n${JSON.stringify(v, (_k, x) => (x instanceof Date ? local(x) : x), 2)}`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const h = createDb(requireEnv('DATABASE_URL'), 1);
try {
  const ctx = await h.db.transaction(
    async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      const [hit] = await tx
        .select()
        .from(orderIntents)
        .where(or(eq(orderIntents.clientOrderId, ref), eq(orderIntents.exchangeOrderId, ref), ...(UUID.test(ref) ? [eq(orderIntents.id, ref)] : [])))
        .limit(1);
      if (!hit) return null;
      const matchedBy = hit.clientOrderId === ref ? 'client order ID (the value My Trades displays)' : hit.id === ref ? 'intent ID' : 'Bitunix order ID';
      const [owner] = await tx.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, hit.ownerId));
      const [acct] = await tx.select().from(paperAccounts).where(eq(paperAccounts.id, hit.paperAccountId));
      const [inst] = await tx.select().from(instruments).where(eq(instruments.id, hit.instrumentId));
      const [decision] = hit.decisionId ? await tx.select().from(signalDecisions).where(eq(signalDecisions.id, hit.decisionId)) : [];
      const [event] = hit.eventId ? await tx.select().from(signalEvents).where(eq(signalEvents.id, hit.eventId)) : [];
      const ledger = await tx.select().from(ledgerEntries).where(and(eq(ledgerEntries.paperAccountId, hit.paperAccountId), eq(ledgerEntries.refId, hit.id))).orderBy(ledgerEntries.createdAt);
      const job = await tx.select().from(jobs).where(eq(jobs.dedupeKey, `${PAPER_SUBMIT_JOB}:${hit.id}`));
      const [conn] = await tx.select().from(exchangeConnections).where(and(eq(exchangeConnections.ownerId, hit.ownerId), eq(exchangeConnections.exchange, acct?.exchange ?? 'BITUNIX')));
      const events = conn
        ? await tx
            .select()
            .from(exchangeAccountEvents)
            .where(and(eq(exchangeAccountEvents.connectionId, conn.id), or(sql`${exchangeAccountEvents.detail}->>'clientId' = ${hit.clientOrderId}`, ...(hit.exchangeOrderId ? [eq(exchangeAccountEvents.exchangeOrderId, hit.exchangeOrderId)] : []))))
            .orderBy(exchangeAccountEvents.createdAt)
        : [];
      const lastWsOrder = conn
        ? await tx.select().from(exchangeAccountEvents).where(and(eq(exchangeAccountEvents.connectionId, conn.id), eq(exchangeAccountEvents.kind, 'ORDER'), eq(exchangeAccountEvents.source, 'WS'))).orderBy(desc(exchangeAccountEvents.createdAt)).limit(3)
        : [];
      const beats = await tx.select().from(serviceHeartbeats).orderBy(desc(serviceHeartbeats.lastSeenAt)).limit(6);
      return { hit, matchedBy, owner, acct, inst, decision, event, ledger, job, conn, events, lastWsOrder, beats };
    },
    { accessMode: 'read only' }
  );
  if (!ctx) {
    console.log(`No order intent has client order ID, intent ID or Bitunix order ID "${ref}".`);
    process.exit(1);
  }
  const { hit, matchedBy, owner, acct, inst, decision, event, ledger, job, conn, events, lastWsOrder, beats } = ctx;
  console.log(`Bitunix order trace · ref ${ref} · ${apply ? 'APPLY (reconcile this one order; reads only at Bitunix)' : 'read-only + dry run'} · ${local(new Date())}`);
  show('Reference', { displayed: ref, matchedBy, persistedClientOrderId: hit.clientOrderId, intentId: hit.id, exchangeOrderId: hit.exchangeOrderId });
  show('Signal event', event ? { id: event.id, action: event.action, source: `${event.sourceExchange}:${event.sourceSymbol}`, interval: event.interval, barOpenAt: event.barOpenAt, receivedAt: event.receivedAt, routeId: event.routeId } : 'none linked');
  show('Entry decision', decision ? { id: decision.id, step: decision.step, status: decision.status, reason: decision.reason, evaluatedAt: decision.evaluatedAt } : 'none linked');
  show('Intent', {
    owner: owner ? `${owner.name} <${owner.email}>` : hit.ownerId,
    account: acct ? { id: acct.id, exchange: acct.exchange, mode: acct.mode, currency: acct.currency, orderReserve: acct.orderReserve, walletBalance: acct.walletBalance } : null,
    instrument: inst ? `${inst.exchange} ${inst.exchangeSymbol} (base ${inst.base}, qtyStep ${inst.qtyStep})` : hit.instrumentId,
    mode: hit.mode,
    kind: hit.kind,
    side: hit.side,
    state: hit.state,
    stateReason: hit.stateReason,
    contracts: hit.contracts,
    quantity: hit.quantity,
    expectedPrice: hit.expectedPrice,
    stop: `${hit.stopPrice} ${hit.stopBasis}`,
    leverage: hit.leverage,
    reservedUsdt: hit.reservedUsdt,
    createdAt: hit.createdAt,
    submittedAt: hit.submittedAt,
    resolvedAt: hit.resolvedAt,
    reconcileAttempts: hit.reconcileAttempts,
    lastReconcileAt: hit.lastReconcileAt,
    lastReconcileNote: hit.lastReconcileNote
  });
  show('Sanitized venue request (as stored)', hit.venueRequest ?? 'none stored (revisions before this fix stored no entry request)');
  show('Venue response (as stored)', hit.venueResponse ?? 'none stored');
  show(
    'Reservation ledger',
    ledger.map((l) => ({ kind: l.kind, amount: l.amount, memo: l.memo, at: l.createdAt }))
  );
  show(
    'Submit job',
    job.length ? job.map((j) => ({ id: j.id, status: j.status, attempts: `${j.attempts}/${j.maxAttempts}`, lastError: j.lastError, runAfter: j.runAfter, claimedBy: j.claimedBy, leaseUntil: j.claimExpiresAt, createdAt: j.createdAt, updatedAt: j.updatedAt, completedAt: j.completedAt })) : 'none (pruned or never queued)'
  );
  show(
    'Worker / web heartbeats',
    beats.map((b) => ({ service: b.service, instance: b.instance, revision: (b.detail as { revision?: string })?.revision ?? null, lastSeenAt: b.lastSeenAt, stoppedAt: b.stoppedAt, lastError: (b.detail as { lastError?: string })?.lastError ?? null }))
  );
  if (!conn) {
    console.log('\nNo exchange connection for this owner and exchange: nothing to query.');
    process.exit(0);
  }
  const st = (conn.streamState ?? {}) as Record<string, unknown>;
  show('Connection', {
    id: conn.id,
    exchange: conn.exchange,
    status: conn.status,
    positionMode: conn.positionMode,
    entriesHalted: conn.entriesHalted,
    haltReason: conn.haltReason,
    lastSyncAt: conn.lastSyncAt,
    lastSyncOkAt: conn.lastSyncOkAt,
    lastSyncError: conn.lastSyncError,
    privateStream: { state: st.state, auth: st.auth, authError: st.authError, lastLogin_readyAt: st.readyAt, lastMessageAt: st.lastMessageAt, reconnects: st.reconnects, eventsByChannel: st.events, updatedAt: st.updatedAt }
  });
  show(
    'Private order events for this order (WS / REST mirror)',
    events.map((e) => ({ kind: e.kind, source: e.source, origin: e.origin, orderId: e.exchangeOrderId, positionId: e.exchangePositionId, businessTime: e.businessTime, receivedAt: e.createdAt, detail: e.detail }))
  );
  show(
    'Last order events received over the private WebSocket (any order)',
    lastWsOrder.map((e) => ({ orderId: e.exchangeOrderId, symbol: e.symbol, businessTime: e.businessTime, receivedAt: e.createdAt, detail: e.detail }))
  );

  // Bitunix, read-only, with the investor's stored key (and its verified own-account tag, if any).
  const r: BitunixRequester = bitunixRequesterFor(conn);
  const symbol = inst?.exchangeSymbol ?? '';
  const safe = async <T>(label: string, f: () => Promise<T>): Promise<T | { error: string }> => {
    try {
      return await f();
    } catch (e) {
      return { error: `${label}: ${(e as Error).name} ${(e as Error).message}` };
    }
  };
  const ok = <T>(v: T | { error: string }): v is T => !(v && typeof v === 'object' && 'error' in (v as object) && Object.keys(v as object).length === 1);
  show('Own-account tag (account_state)', { ownSubAccountId: (conn.accountState as { ownSubAccountId?: string })?.ownSubAccountId ?? null, evidence: (conn.accountState as { ownSubAccountEvidence?: string })?.ownSubAccountEvidence ?? null });
  const detail = await safe('get_order_detail', () => r.get<unknown>('/api/v1/futures/trade/get_order_detail', { clientId: hit.clientOrderId }));
  show(`Bitunix get_order_detail {clientId: ${hit.clientOrderId}}`, detail ?? 'null (no order)');
  const opts = { maxPages: 50, includeSubAccountRows: true, collectRowErrors: true };
  const pending = await safe('get_pending_orders', () => readPendingOrders(r, opts));
  show('Bitunix open orders (all)', ok(pending) ? pending : pending);
  // Complete order history of the symbol: no time bounds, every page, tagged rows included; rows that
  // cannot be parsed are listed with their identifiers instead of aborting the read.
  const read = await safe('get_history_orders', () => readHistoryOrders(r, { symbol }, opts));
  const history = ok(read) ? read.items : [];
  const mine = history.filter((o) => o.clientId === hit.clientOrderId);
  show(`Bitunix order history ${symbol} — this clientId`, ok(read) ? mine : read);
  if (ok(read)) {
    show(
      `Bitunix order history ${symbol} — all (${history.length} parsed, ${read.pages} page(s), ${read.skipped?.length ?? 0} unparseable)`,
      history.map((o) => ({ orderId: o.orderId, clientId: o.clientId, origin: o.origin, side: o.side, type: o.orderType, qty: o.qty, tradeQty: o.tradeQty, requestedPrice: o.requestedPrice, avgPrice: o.avgPrice, reduceOnly: o.reduceOnly, status: o.status, ctime: o.ctimeMs ? new Date(o.ctimeMs).toISOString() : null, issues: o.issues }))
    );
    if (read.skipped?.length) show('Unparseable history rows (identifiers kept)', read.skipped);
  }
  const fromMs = hit.createdAt.getTime() - 60 * 60_000;
  const trades = await safe('get_history_trades', () => readHistoryTrades(r, { startTime: fromMs }, { maxPages: 50 }));
  show(
    `Bitunix fills (all symbols) since ${new Date(fromMs).toISOString()}`,
    ok(trades) ? trades.items.map((t) => ({ tradeId: t.tradeId, orderId: t.orderId, symbol: t.symbol, side: t.side, qty: t.qty, price: t.price, fee: t.fee, realizedPNL: t.realizedPNL, reduceOnly: t.reduceOnly, ctime: t.ctimeMs ? new Date(t.ctimeMs).toISOString() : null })) : trades
  );
  const orderId = mine[0]?.orderId || hit.exchangeOrderId || (detail && typeof detail === 'object' && 'orderId' in (detail as object) ? String((detail as { orderId: unknown }).orderId) : null);
  if (orderId) show(`Bitunix fills for order ${orderId}`, await safe('get_history_trades', async () => (await readHistoryTrades(r, { orderId }, { maxPages: 5 })).items.filter((t) => t.orderId === orderId)));
  show(`Bitunix open positions ${symbol}`, await safe('get_pending_positions', async () => (await readPendingPositions(r, { symbol })).items));
  show(`Bitunix position history ${symbol}`, await safe('get_history_positions', async () => (await readHistoryPositions(r, { symbol }, { maxPages: 5, includeSubAccountRows: true })).items));
  show(`Bitunix open TP/SL ${symbol}`, await safe('tpsl/get_pending_orders', async () => (await readPendingTpsl(r)).items.filter((t) => t.symbol === symbol)));

  const out = await reconcileBitunixIntents(h.db, conn, r, new Date(), { clientOrderId: hit.clientOrderId, apply });
  show(apply ? 'Reconciliation (APPLIED)' : 'Reconciliation (DRY RUN — run with --apply to write this outcome)', out.length ? out : `intent is ${hit.state}: nothing to reconcile`);
  if (apply) {
    const [after] = await h.db.select().from(orderIntents).where(eq(orderIntents.id, hit.id));
    const [acctAfter] = await h.db.select().from(paperAccounts).where(eq(paperAccounts.id, hit.paperAccountId));
    show('After', { state: after?.state, stateReason: after?.stateReason, exchangeOrderId: after?.exchangeOrderId, orderReserve: acctAfter?.orderReserve, lastReconcileNote: after?.lastReconcileNote });
  }
} finally {
  await h.close();
}
