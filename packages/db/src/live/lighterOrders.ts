import { randomUUID } from 'node:crypto';
import { and, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import {
  buildOpenWithStop,
  buildReduceOnlyClose,
  checkLighterSize,
  decideUncertainTx,
  Decimal,
  fromScaledInt,
  LIGHTER_ERR,
  LIGHTER_FINAL_ORDER_STATUSES,
  LIGHTER_TX_TYPE,
  missingLiveInputs,
  toScaledInt,
  worstPrice,
  type LighterEnvironment,
  type LighterLiveInputs,
  type LighterMarketRules,
  type LighterOrderReq
} from '@trendpilot/domain';
import type { Db } from '../client';
import { lighterNonces, lighterTxs } from '../schema';
import type { CloseResult, OpeningRequest, SimFill, SimResult, VenueDiagnostics } from '../paper/simulator';
import type { CloseRequest, ExecutionVenue, ProtectionState } from '../venue/types';
import { livePilotVerified, type CapabilityState, type LighterCapabilityId } from './capabilities';
import { LighterPrivateError, type LighterAccountSnapshot, type LighterApi, type LighterOrder, type LighterSignedTx, type LighterSigner } from './lighterPrivate';
import { UncertainSubmissionError } from './mexcVenue';

/**
 * Lighter ORDER path (Lighter plan Step 4), behind the shared ExecutionVenue interface:
 *  - Opening: ONE CreateGroupedOrders transaction (OTO): MARKET IOC entry with a worst-price bound
 *    from the FRESH Lighter book + reduce-only STOP_LOSS child (mark-price trigger). Coverage is
 *    then verified against the CONFIRMED filled size; a partial fill resizes the stop (ModifyOrder)
 *    when that capability is verified, and otherwise the shared flow sees the mismatch, halts new
 *    entries and runs the emergency reduce-only close.
 *  - Closing (fixed TP, trailing TP / Target Close, Close on Signal, manual, emergency): MARKET IOC
 *    reduce-only, capped at the position Lighter reports now, never more.
 *  - Netting: Lighter keeps ONE net position per market. An entry is refused while Lighter holds
 *    any position or any open/pending order on that market (no add, no reversal, no stale stop that
 *    could act on a new position). TrendPilot never changes leverage, margin mode or trading mode.
 *
 * Idempotency (docs "Retrying safely"): every action is a `lighter_txs` row written BEFORE signing,
 * with stable client order indexes; its nonce and transaction hash are recorded BEFORE sending.
 * Only the holder of the API key's lease (lighter_nonces) signs and sends, so workers sharing the
 * key send in nonce order. An uncertain send is reconciled (tx status by hash + nextNonce) and is
 * resent only with the SAME nonce; a definitive API rejection frees its nonce. Nothing re-signs an
 * order with a new nonce while the old one could still execute.
 *
 * Every order capability must be recorded as verified (Admin → Live Trading); none is in this
 * build, so the production path refuses before signing (and the signer itself is unavailable).
 */

const D = (v: Decimal.Value) => new Decimal(v);
const STOP_PREFIX = 'lighter-sl:';
const stopRefOf = (marketId: number, clientOrderIndex: number) => `${STOP_PREFIX}${marketId}:${clientOrderIndex}`;
const parseStopRef = (ref: string): { marketId: number; clientOrderIndex: number } | null => {
  const m = /^lighter-sl:(\d+):(\d+)$/.exec(ref);
  return m ? { marketId: Number(m[1]), clientOrderIndex: Number(m[2]) } : null;
};
const UNCERTAIN_STATES = ['SENDING', 'UNKNOWN'] as const;

export type LighterTxRow = typeof lighterTxs.$inferSelect;

export interface LighterScope {
  connectionId: string;
  ownerId: string;
  environment: LighterEnvironment;
  accountIndex: number;
  apiKeyIndex: number;
}

export interface LighterVenueMarket extends LighterMarketRules {
  symbol: string;
}

export interface LighterVenueOptions {
  db: Db;
  scope: LighterScope;
  api: LighterApi;
  signer: LighterSigner;
  marketFor: (instrumentId: string) => Promise<LighterVenueMarket>;
  inputs: LighterLiveInputs;
  capabilities?: CapabilityState;
  confirm?: { attempts: number; delayMs: number };
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Identifies this process in nonce leases. */
  leaseOwner?: string;
  leaseMs?: number;
}

export class LighterKeyBusy extends Error {
  constructor(reason: string) {
    super(`Lighter API key busy: ${reason}`);
    this.name = 'LighterKeyBusy';
  }
}

/* ───────────────────────── Nonce lease (per account + API key) ───────────────────────── */

const keyWhere = (s: LighterScope) => and(eq(lighterNonces.environment, s.environment), eq(lighterNonces.accountIndex, s.accountIndex), eq(lighterNonces.apiKeyIndex, s.apiKeyIndex));

/** Takes the key's lease (database time). False when another live holder has it. */
export async function acquireLighterKeyLease(db: Db, s: LighterScope, owner: string, leaseMs: number): Promise<boolean> {
  await db.insert(lighterNonces).values({ environment: s.environment, accountIndex: s.accountIndex, apiKeyIndex: s.apiKeyIndex }).onConflictDoNothing();
  const [got] = await db
    .update(lighterNonces)
    .set({ leaseOwner: owner, leaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})`, updatedAt: sql`now()` })
    .where(and(keyWhere(s), sql`(${lighterNonces.leaseUntil} IS NULL OR ${lighterNonces.leaseUntil} < now() OR ${lighterNonces.leaseOwner} = ${owner})`))
    .returning({ owner: lighterNonces.leaseOwner });
  return !!got;
}

export async function releaseLighterKeyLease(db: Db, s: LighterScope, owner: string): Promise<void> {
  await db.update(lighterNonces).set({ leaseOwner: null, leaseUntil: null, updatedAt: sql`now()` }).where(and(keyWhere(s), eq(lighterNonces.leaseOwner, owner)));
}

/* ───────────────────────── Venue ───────────────────────── */

export function lighterVenue(o: LighterVenueOptions): ExecutionVenue & { reconcileGraceMs: number } {
  const { db, scope, api, signer } = o;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const confirm = o.confirm ?? { attempts: 5, delayMs: 400 };
  const now = o.now ?? (() => new Date());
  const owner = o.leaseOwner ?? `lighter-${randomUUID()}`;
  const leaseMs = o.leaseMs ?? 30_000;
  const verified = (c: LighterCapabilityId) => livePilotVerified(c, o.capabilities);
  const missing = (ids: LighterCapabilityId[]) => ids.find((c) => !verified(c));

  let token: { value: string; until: number } | null = null;
  /** Auth token for account-scoped reads, signed by the API key (never logged). */
  const auth = async () => {
    const t = now().getTime();
    if (!token || token.until - t < 60_000) {
      const until = Math.floor(t / 1000) + 600;
      token = { value: await signer.createAuthToken(until), until: until * 1000 };
    }
    return token.value;
  };

  const rowFor = async (clientOrderId: string): Promise<LighterTxRow | null> => {
    const [r] = await db.select().from(lighterTxs).where(and(eq(lighterTxs.connectionId, scope.connectionId), eq(lighterTxs.clientOrderId, clientOrderId)));
    return r ?? null;
  };
  const nextIndex = async (): Promise<number> => {
    const r = await db.execute(sql`SELECT nextval('lighter_client_order_index_seq') AS v`);
    return Number((r.rows[0] as { v: string }).v);
  };
  type TxPatch = { [K in keyof typeof lighterTxs.$inferInsert]?: (typeof lighterTxs.$inferInsert)[K] | SQL };
  const patch = (id: string, set: TxPatch) => db.update(lighterTxs).set({ ...set, updatedAt: sql`now()` }).where(eq(lighterTxs.id, id));

  /** Persists the action before anything is signed (stable client order indexes). */
  const prepare = async (r: { clientOrderId: string; purpose: 'OPEN_WITH_STOP' | 'CLOSE' | 'STOP_RESIZE'; marketId: number; txType: number; clientOrderIndex?: number; withStop?: boolean; request: Record<string, unknown> }): Promise<LighterTxRow> => {
    const clientOrderIndex = r.clientOrderIndex ?? (await nextIndex());
    const stopClientOrderIndex = r.withStop ? await nextIndex() : null;
    const [row] = await db
      .insert(lighterTxs)
      .values({ ownerId: scope.ownerId, connectionId: scope.connectionId, environment: scope.environment, accountIndex: scope.accountIndex, apiKeyIndex: scope.apiKeyIndex, clientOrderId: r.clientOrderId, purpose: r.purpose, marketId: r.marketId, clientOrderIndex, stopClientOrderIndex, txType: r.txType, request: r.request })
      .onConflictDoNothing()
      .returning();
    return row ?? (await rowFor(r.clientOrderId))!;
  };

  type Sent = { ok: true } | { ok: false; reason: string; code: number | string; message: string };

  /**
   * Signs and sends `row` under the key's lease. A row that was never sent gets the key's next
   * nonce; a row being RESENT keeps its own nonce. The nonce and hash are stored before sending.
   */
  const send = async (row: LighterTxRow, sign: (nonce: number) => Promise<LighterSignedTx>, resend: boolean): Promise<Sent> => {
    // One lease token per send: concurrent sends in THIS process must also wait for each other.
    const holder = `${owner}:${randomUUID()}`;
    // Bounded wait for the key (real time; independent of order-confirmation polling).
    for (let i = 0; !(await acquireLighterKeyLease(db, scope, holder, leaseMs)); i++) {
      if (i >= 100) throw new LighterKeyBusy('another worker holds the nonce lease');
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      if (!resend) {
        // A different action on this key whose outcome is unknown blocks new nonces until it is reconciled.
        const blocking = await db
          .select({ id: lighterTxs.id, clientOrderId: lighterTxs.clientOrderId })
          .from(lighterTxs)
          .where(and(eq(lighterTxs.environment, scope.environment), eq(lighterTxs.accountIndex, scope.accountIndex), eq(lighterTxs.apiKeyIndex, scope.apiKeyIndex), inArray(lighterTxs.state, [...UNCERTAIN_STATES]), ne(lighterTxs.id, row.id)));
        if (blocking.length) throw new LighterKeyBusy(`transaction ${blocking[0]!.clientOrderId} on this key is unresolved`);
      }
      let nonce = row.nonce;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (nonce === null || (!resend && attempt > 0)) {
          const [k] = await db.select().from(lighterNonces).where(keyWhere(scope));
          nonce = k?.nextNonce ?? (await api.nextNonce(scope.accountIndex, scope.apiKeyIndex));
        }
        const signed = await sign(nonce);
        // Recorded BEFORE sending: after a crash the hash and nonce identify what may have reached Lighter.
        await patch(row.id, { state: 'SENDING', nonce, txHash: signed.txHash, attempts: sql`${lighterTxs.attempts} + 1` });
        await db.update(lighterNonces).set({ nextNonce: nonce + 1, refreshedAt: sql`now()`, updatedAt: sql`now()` }).where(keyWhere(scope));
        try {
          await api.sendTx(signed.txType, signed.txInfo);
          await patch(row.id, { state: 'ACCEPTED', response: sql`${lighterTxs.response} || ${JSON.stringify({ code: 200, at: now().toISOString() })}::jsonb` });
          return { ok: true };
        } catch (e) {
          const le = e instanceof LighterPrivateError ? e : null;
          if (!le || le.kind === 'TIMEOUT' || le.kind === 'NETWORK' || le.kind === 'PARSE' || (le.kind === 'HTTP' && (le.code ?? 0) >= 500)) {
            await patch(row.id, { state: 'UNKNOWN', response: { code: le?.kind ?? 'ERROR', message: (e as Error).message.slice(0, 200) } });
            throw new UncertainSubmissionError(row.clientOrderId, (e as Error).message);
          }
          // A definitive API rejection does not consume the nonce (docs): it is free again.
          await db.update(lighterNonces).set({ nextNonce: nonce, updatedAt: sql`now()` }).where(keyWhere(scope));
          if (le.kind === 'API' && le.code === LIGHTER_ERR.INVALID_NONCE && attempt === 0) {
            // Nonce conflict (another client used this key): the transaction did not execute. Refresh
            // from Lighter and sign once more; a resend keeps its nonce only when Lighter still expects it.
            const fresh = await api.nextNonce(scope.accountIndex, scope.apiKeyIndex);
            await db.update(lighterNonces).set({ nextNonce: fresh, refreshedAt: sql`now()`, updatedAt: sql`now()` }).where(keyWhere(scope));
            if (resend && fresh !== nonce) {
              await patch(row.id, { state: 'UNKNOWN', response: { code: le.code, message: `nonce ${nonce} no longer expected (next ${fresh}); not re-signed with a new nonce` } });
              throw new UncertainSubmissionError(row.clientOrderId, 'nonce moved on during resend');
            }
            nonce = fresh;
            continue;
          }
          await patch(row.id, { state: 'API_REJECTED', response: { code: le.code ?? le.kind, message: le.message.slice(0, 200) } });
          return { ok: false, reason: `LIGHTER_${le.code ?? le.kind}`, code: le.code ?? le.kind, message: le.message.slice(0, 200) };
        }
      }
      throw new UncertainSubmissionError(row.clientOrderId, 'nonce conflict persisted');
    } finally {
      await releaseLighterKeyLease(db, scope, holder);
    }
  };

  /**
   * Brings a row whose send outcome is unknown to a known state (docs "Retrying safely"). Returns
   * 'ACCEPTED' / 'EXECUTED' (look at the orders), 'FAILED' (nothing was created) or throws while
   * it cannot be known.
   */
  const reconcileSend = async (row: LighterTxRow, sign: (nonce: number) => Promise<LighterSignedTx>): Promise<'EXECUTED' | 'ACCEPTED' | 'FAILED'> => {
    if (row.nonce === null || !row.txHash) {
      // Never reached the signing step with a nonce: nothing can have been sent.
      const r = await send(row, sign, false);
      return r.ok ? 'ACCEPTED' : 'FAILED';
    }
    const status = await api.txStatus(row.txHash);
    const next = await api.nextNonce(scope.accountIndex, scope.apiKeyIndex);
    const decision = decideUncertainTx({ txStatus: status, nextNonce: next, nonce: row.nonce });
    await patch(row.id, { response: { ...(row.response as object), reconcile: { txStatus: status, nextNonce: next, decision, at: now().toISOString() } } });
    if (decision === 'EXECUTED') {
      await patch(row.id, { state: 'EXECUTED' });
      return 'EXECUTED';
    }
    if (decision === 'FAILED_NONCE_CONSUMED') {
      await patch(row.id, { state: 'FAILED' });
      return 'FAILED';
    }
    if (decision === 'RESEND_SAME_NONCE' || decision === 'FAILED_RESEND_SAME_NONCE') {
      const r = await send(row, sign, true);
      return r.ok ? 'ACCEPTED' : 'FAILED';
    }
    throw new UncertainSubmissionError(row.clientOrderId, decision === 'WAIT' ? 'transaction still queued at Lighter' : `transaction ${row.txHash} not found and nonce ${row.nonce} already used (next ${next})`);
  };

  const ordersOf = async (indexes: number[]): Promise<Map<number, LighterOrder>> => {
    const list = await api.ordersByClientIndex(scope.accountIndex, indexes, await auth());
    return new Map(list.map((x) => [x.clientOrderIndex, x]));
  };

  /** Polls until the order with this client index is final. Null = still not final / not visible. */
  const untilFinal = async (clientOrderIndex: number): Promise<LighterOrder | null> => {
    for (let i = 0; i < confirm.attempts; i++) {
      const ord = (await ordersOf([clientOrderIndex])).get(clientOrderIndex);
      if (ord && LIGHTER_FINAL_ORDER_STATUSES.has(ord.status)) return ord;
      if (i < confirm.attempts - 1) await sleep(confirm.delayMs);
    }
    return null;
  };

  /** Actual fills from Lighter's trade records for the order. Fees must be established by the record. */
  const fillOf = async (ord: LighterOrder, sizeDecimals: number): Promise<SimFill> => {
    let trades = await api.tradesForOrder(scope.accountIndex, ord.orderIndex, await auth());
    for (let i = 1; !trades.length && i < confirm.attempts; i++) {
      await sleep(confirm.delayMs);
      trades = await api.tradesForOrder(scope.accountIndex, ord.orderIndex, await auth());
    }
    if (!trades.length) throw new UncertainSubmissionError(String(ord.clientOrderIndex), 'fills not listed yet');
    if (trades.some((t) => t.fee === null)) throw new UncertainSubmissionError(String(ord.clientOrderIndex), 'fill fee not established by Lighter records (LIGHTER_FILL_FEES)');
    const qty = trades.reduce((t, x) => t.plus(x.size), D(0));
    void sizeDecimals;
    return {
      fillId: `lighter:${scope.accountIndex}:${ord.orderIndex}`,
      contracts: qty.toFixed(),
      price: trades.reduce((t, x) => t.plus(D(x.price).times(x.size)), D(0)).div(qty).toDecimalPlaces(12).toFixed(),
      fee: trades.reduce((t, x) => t.plus(x.fee!), D(0)).toDecimalPlaces(8).toFixed(),
      filledAt: new Date(Math.max(...trades.map((t) => t.timestampMs)) || now().getTime())
    };
  };

  const snapshot = async (): Promise<LighterAccountSnapshot> => {
    const s = await api.account(scope.accountIndex);
    if (!s) throw new LighterPrivateError(`Lighter account ${scope.accountIndex} not found`, 'API');
    return s;
  };
  const freshBook = async (marketId: number): Promise<{ bid: string; ask: string } | string> => {
    const b = await api.orderBook(marketId);
    if (!b.bestBid || !b.bestAsk) return 'LIGHTER_BOOK_UNAVAILABLE: no bid or ask on the Lighter book';
    if (!D(b.bestBid).lt(b.bestAsk)) return `LIGHTER_BOOK_CROSSED: bid ${b.bestBid} ≥ ask ${b.bestAsk}`;
    return { bid: b.bestBid, ask: b.bestAsk };
  };

  /* ── stop ── */

  const stopState = async (ref: string): Promise<ProtectionState | null> => {
    const p = parseStopRef(ref);
    if (!p) return null;
    const ord = (await ordersOf([p.clientOrderIndex])).get(p.clientOrderIndex);
    if (!ord || ord.marketIndex !== p.marketId) return null;
    // Armed = waiting for the MARK trigger ('pending' + trigger_status 'mark-price'). A child still
    // waiting for its parent, a triggered, cancelled or expired stop is not protection.
    const armed = ord.status === 'pending' && ord.triggerStatus === 'mark-price';
    const expired = ord.orderExpiryMs > 0 && ord.orderExpiryMs <= now().getTime();
    return {
      status: armed && !expired ? 'ACTIVE' : expired ? 'EXPIRED' : ord.status === 'pending' ? `WAITING_${ord.triggerStatus.toUpperCase()}` : ord.status.toUpperCase(),
      side: ord.isAsk ? 'SHORT' : 'LONG',
      contracts: ord.remainingBaseAmount,
      triggerPrice: ord.triggerPrice,
      basis: 'MARK',
      reduceOnly: ord.reduceOnly,
      expiresAt: ord.orderExpiryMs > 0 ? new Date(ord.orderExpiryMs).toISOString() : null
    };
  };

  /** ModifyOrder of the stop to `contracts` at the SAME trigger and bound; confirmed by re-reading. */
  const resizeStop = async (ref: string, contracts: string, market: LighterVenueMarket): Promise<boolean> => {
    if (!verified('LIGHTER_STOP_RESIZE')) return false;
    const p = parseStopRef(ref);
    if (!p) return false;
    const ord = (await ordersOf([p.clientOrderIndex])).get(p.clientOrderIndex);
    if (!ord || !ord.reduceOnly) return false;
    if (D(ord.remainingBaseAmount).eq(contracts)) return true;
    const base = toScaledInt(contracts, market.sizeDecimals, 'DOWN');
    if (D(base).lte(0)) return false;
    const request = { marketIndex: p.marketId, index: p.clientOrderIndex, baseAmount: base, price: toScaledInt(ord.price, market.priceDecimals, 'EXACT'), triggerPrice: toScaledInt(ord.triggerPrice, market.priceDecimals, 'EXACT') };
    const row = await prepare({ clientOrderId: `${ref}:resize:${D(contracts).toFixed()}`, purpose: 'STOP_RESIZE', marketId: p.marketId, txType: LIGHTER_TX_TYPE.MODIFY_ORDER, clientOrderIndex: p.clientOrderIndex, request });
    const sign = (n: number) => signer.signModifyOrder(request, n);
    if (row.state === 'PREPARED') {
      if (!(await send(row, sign, false)).ok) return false;
    } else if ((UNCERTAIN_STATES as readonly string[]).includes(row.state)) {
      if ((await reconcileSend(row, sign)) === 'FAILED') return false;
    } else if (row.state === 'API_REJECTED' || row.state === 'FAILED') return false;
    for (let i = 0; i < confirm.attempts; i++) {
      const s = await stopState(ref);
      if (s && D(s.contracts).eq(contracts) && s.triggerPrice !== null && D(s.triggerPrice).eq(ord.triggerPrice)) return true;
      if (i < confirm.attempts - 1) await sleep(confirm.delayMs);
    }
    return false;
  };

  /* ── open ── */

  const openResult = async (row: LighterTxRow, market: LighterVenueMarket): Promise<SimResult> => {
    const entry = await untilFinal(row.clientOrderIndex);
    if (!entry) {
      // Not visible / not final: a transaction that FAILED created nothing.
      if (row.txHash && (await api.txStatus(row.txHash)) === 0 && (await api.nextNonce(scope.accountIndex, scope.apiKeyIndex)) > (row.nonce ?? Number.MAX_SAFE_INTEGER)) {
        await patch(row.id, { state: 'FAILED' });
        return { status: 'REJECTED', orderId: '', clientOrderId: row.clientOrderId, reason: 'LIGHTER_TX_FAILED' };
      }
      throw new UncertainSubmissionError(row.clientOrderId, 'entry order not final after confirmation polling');
    }
    if (row.state !== 'EXECUTED') await patch(row.id, { state: 'EXECUTED' });
    if (D(entry.filledBaseAmount).isZero()) return { status: 'REJECTED', orderId: entry.orderIndex, clientOrderId: row.clientOrderId, reason: `LIGHTER_ORDER_${entry.status.toUpperCase()}` };
    const fill = await fillOf(entry, market.sizeDecimals);
    const ref = stopRefOf(market.marketId, row.stopClientOrderIndex!);
    // The linked stop must cover exactly the CONFIRMED filled size (full or partial fill).
    let stop = await stopState(ref);
    for (let i = 1; (!stop || stop.status !== 'ACTIVE') && i < confirm.attempts; i++) {
      await sleep(confirm.delayMs);
      stop = await stopState(ref);
    }
    if (stop && stop.status === 'ACTIVE' && !D(stop.contracts).eq(fill.contracts)) {
      await resizeStop(ref, fill.contracts, market);
      stop = await stopState(ref);
    }
    return {
      status: 'FILLED',
      orderId: entry.orderIndex,
      clientOrderId: row.clientOrderId,
      fill,
      positionRef: null,
      stop: { orderId: ref, clientOrderId: ref, triggerPrice: stop?.triggerPrice ?? fromScaledInt((row.request as { stopTrigger: string }).stopTrigger, market.priceDecimals), basis: 'MARK', contracts: stop?.contracts ?? '0', reduceOnly: stop?.reduceOnly ?? true }
    };
  };

  const groupedOf = (row: LighterTxRow) => {
    const r = row.request as { groupingType: number; orders: LighterOrderReq[] };
    return (n: number) => signer.signCreateGroupedOrders({ groupingType: r.groupingType, orders: r.orders }, n);
  };

  /* ── close ── */

  const closeResult = async (row: LighterTxRow, market: LighterVenueMarket): Promise<CloseResult> => {
    const ord = await untilFinal(row.clientOrderIndex);
    const requested = fromScaledInt((row.request as LighterOrderReq).BaseAmount, market.sizeDecimals);
    if (!ord) {
      if (row.txHash && (await api.txStatus(row.txHash)) === 0 && (await api.nextNonce(scope.accountIndex, scope.apiKeyIndex)) > (row.nonce ?? Number.MAX_SAFE_INTEGER)) {
        await patch(row.id, { state: 'FAILED' });
        return { status: 'REJECTED', orderId: '', clientOrderId: row.clientOrderId, reason: 'LIGHTER_TX_FAILED' };
      }
      throw new UncertainSubmissionError(row.clientOrderId, 'close not final after confirmation polling');
    }
    if (row.state !== 'EXECUTED') await patch(row.id, { state: 'EXECUTED' });
    if (D(ord.filledBaseAmount).isZero()) return { status: 'REJECTED', orderId: ord.orderIndex, clientOrderId: row.clientOrderId, reason: `LIGHTER_ORDER_${ord.status.toUpperCase()}` };
    const fill = await fillOf(ord, market.sizeDecimals);
    return { status: D(fill.contracts).gte(requested) ? 'FILLED' : 'PARTIAL', orderId: ord.orderIndex, clientOrderId: row.clientOrderId, requested, fill };
  };

  return {
    kind: 'LIGHTER_PRIVATE',
    reconcileGraceMs: 30_000,

    async placeOpeningOrderWithStop(req: OpeningRequest): Promise<SimResult> {
      const reject = (reason: string): SimResult => ({ status: 'REJECTED', orderId: '', clientOrderId: req.clientOrderId, reason });
      if (!req.stop) return reject('STOP_REQUIRED');
      const market = await o.marketFor(req.instrumentId);
      const existing = await rowFor(req.clientOrderId);
      if (existing && existing.state !== 'PREPARED') {
        // Already signed (maybe sent): reconcile; never prepare a second order for this intent.
        if (existing.state === 'API_REJECTED' || existing.state === 'FAILED') return reject(`LIGHTER_${String((existing.response as { code?: unknown }).code ?? existing.state)}`);
        if ((UNCERTAIN_STATES as readonly string[]).includes(existing.state) && (await reconcileSend(existing, groupedOf(existing))) === 'FAILED') return reject('LIGHTER_TX_FAILED');
        return openResult((await rowFor(req.clientOrderId))!, market);
      }
      const cap = missing(['LIGHTER_SIGNER', 'LIGHTER_KEY_MATCH', 'LIGHTER_ACCOUNT_SETTINGS', 'LIGHTER_OPEN_WITH_LINKED_STOP', 'LIGHTER_ORDER_LOOKUP', 'LIGHTER_FILL_FEES', ...(market.marketId === 92 ? (['LIGHTER_XAU_EXECUTION'] as const) : [])]);
      if (cap) return reject(`CAPABILITY_UNVERIFIED:${cap}`);
      const gaps = missingLiveInputs(o.inputs, 'OPEN');
      if (gaps.length) return reject(`LIVE_INPUT_UNRESOLVED:${gaps.join(',')}`);
      if (req.stop.basis !== 'MARK') return reject(`STOP_BASIS_UNSUPPORTED:${req.stop.basis} (Lighter stops trigger on the mark price)`);
      if (!req.leverage) return reject('LEVERAGE_REQUIRED');

      // Fresh Lighter execution data and the account as Lighter reports it now.
      const book = await freshBook(market.marketId);
      if (typeof book === 'string') return reject(book);
      const acct = await snapshot();
      const here = acct.positions.find((p) => p.marketId === market.marketId);
      if (here && D(here.size).gt(0)) return reject(here.side !== req.side ? `NETTING_REFUSED: Lighter holds a ${here.side ?? 'net'} ${here.size} ${market.symbol}; a ${req.side} order would net or reverse it` : `POSITION_EXISTS: Lighter already holds ${here.size} ${market.symbol} ${here.side}; adding is not supported`);
      if (here && here.openOrderCount + here.pendingOrderCount > 0) return reject(`CONFLICTING_ORDERS: ${here.openOrderCount + here.pendingOrderCount} open or pending order(s) on ${market.symbol} at Lighter`);
      const wantMode = req.marginMode ?? 'ISOLATED';
      if (!here || here.marginMode === null || here.leverage === null) return reject(`LIGHTER_SETTINGS_UNKNOWN: Lighter reports no margin mode / leverage for ${market.symbol}; set them on Lighter first`);
      if (here.marginMode !== wantMode) return reject(`LIGHTER_SETTINGS_MISMATCH:MARGIN_MODE: Lighter ${here.marginMode}, order ${wantMode}`);
      if (here.leverage !== req.leverage) return reject(`LIGHTER_SETTINGS_MISMATCH:LEVERAGE: Lighter ${here.leverage}x, order ${req.leverage}x`);

      const isAsk = req.side === 'SHORT';
      const ref = isAsk ? book.bid : book.ask;
      const baseAmount = toScaledInt(req.contracts, market.sizeDecimals, 'DOWN');
      const qty = fromScaledInt(baseAmount, market.sizeDecimals);
      const sizeIssue = checkLighterSize(qty, ref, market);
      if (sizeIssue) return reject(sizeIssue);
      // Stop rounded to the tick WITHOUT widening the risk, and on the protective side of the book.
      const stopTrigger = toScaledInt(req.stop.price, market.priceDecimals, req.side === 'LONG' ? 'UP' : 'DOWN');
      const stopPx = fromScaledInt(stopTrigger, market.priceDecimals);
      if (req.side === 'LONG' ? !D(stopPx).lt(book.bid) : !D(stopPx).gt(book.ask)) return reject(`STOP_PRICE_INVALID: ${req.side} stop ${stopPx} is not ${req.side === 'LONG' ? `below the bid ${book.bid}` : `above the ask ${book.ask}`}`);
      // Margin: notional / leverage + taker fee (the account's own rate), against Lighter's available balance.
      const notional = D(qty).times(ref);
      const required = notional.div(req.leverage).plus(notional.times(o.inputs.takerFeeRate!));
      if (required.gt(acct.availableBalance)) return reject(`INSUFFICIENT_MARGIN: needs ${required.toDecimalPlaces(6).toFixed()} USDC, Lighter shows ${acct.availableBalance} available`);

      const entryWorst = worstPrice(isAsk, ref, o.inputs.entryWorstPricePct!, market.priceDecimals);
      const stopWorst = worstPrice(!isAsk, stopPx, o.inputs.stopWorstPricePct!, market.priceDecimals);
      const prepared = existing ?? (await prepare({ clientOrderId: req.clientOrderId, purpose: 'OPEN_WITH_STOP', marketId: market.marketId, txType: LIGHTER_TX_TYPE.CREATE_GROUPED_ORDERS, withStop: true, request: {} }));
      const group = buildOpenWithStop({ side: req.side, rules: market, baseAmount, entryWorstPrice: entryWorst, stopTrigger, stopWorstPrice: stopWorst, entryClientOrderIndex: prepared.clientOrderIndex, stopClientOrderIndex: prepared.stopClientOrderIndex!, nowMs: now().getTime() });
      const request = { ...group, stopTrigger, context: { book, available: acct.availableBalance, requiredMargin: required.toDecimalPlaces(6).toFixed() } };
      await patch(prepared.id, { request });
      const row = (await rowFor(req.clientOrderId))!;
      const sent = await send(row, groupedOf(row), false);
      if (!sent.ok) return reject(sent.reason);
      return openResult((await rowFor(req.clientOrderId))!, market);
    },

    async lookupOrder(clientOrderId, instrumentId) {
      const row = await rowFor(clientOrderId);
      // Never prepared, or prepared but never signed: nothing can be at Lighter.
      if (!row || row.state === 'PREPARED') return null;
      const market = await o.marketFor(instrumentId);
      if (row.state === 'API_REJECTED' || row.state === 'FAILED') return { status: 'REJECTED', orderId: '', clientOrderId, reason: `LIGHTER_${String((row.response as { code?: unknown }).code ?? row.state)}` };
      if ((UNCERTAIN_STATES as readonly string[]).includes(row.state) && (await reconcileSend(row, groupedOf(row))) === 'FAILED') return { status: 'REJECTED', orderId: '', clientOrderId, reason: 'LIGHTER_TX_FAILED' };
      return openResult((await rowFor(clientOrderId))!, market);
    },

    async inspectProtection(stopOrderId) {
      return stopState(stopOrderId);
    },

    async placeReduceOnlyClose(req: CloseRequest): Promise<CloseResult> {
      const reject = (reason: string, diagnostics?: VenueDiagnostics): CloseResult => ({ status: 'REJECTED', orderId: '', clientOrderId: req.clientOrderId, reason, ...(diagnostics ? { diagnostics } : {}) });
      const notSent = (reason: string, message: string) => reject(reason, { request: null, response: { code: 'NOT_SENT', message: message.slice(0, 200) } });
      const market = await o.marketFor(req.instrumentId);
      const existing = await rowFor(req.clientOrderId);
      if (existing && existing.state !== 'PREPARED') {
        if (existing.state === 'API_REJECTED' || existing.state === 'FAILED') return reject(`LIGHTER_${String((existing.response as { code?: unknown }).code ?? existing.state)}`);
        const sign = (n: number) => signer.signCreateOrder(existing.request as LighterOrderReq, n);
        if ((UNCERTAIN_STATES as readonly string[]).includes(existing.state) && (await reconcileSend(existing, sign)) === 'FAILED') return reject('LIGHTER_TX_FAILED');
        return closeResult((await rowFor(req.clientOrderId))!, market);
      }
      const cap = missing(['LIGHTER_SIGNER', 'LIGHTER_REDUCE_ONLY_CLOSE', 'LIGHTER_ORDER_LOOKUP', 'LIGHTER_FILL_FEES']);
      if (cap) return reject(`CAPABILITY_UNVERIFIED:${cap}`);
      const gaps = missingLiveInputs(o.inputs, 'CLOSE');
      if (gaps.length) return notSent(`LIVE_INPUT_UNRESOLVED:${gaps.join(',')}`, 'the close price bound is not configured');
      // The position Lighter holds NOW caps the close: a reduce-only close can never open the other side.
      const here = (await snapshot()).positions.find((p) => p.marketId === market.marketId);
      if (!here || D(here.size).isZero()) return notSent('REDUCE_ONLY_NO_POSITION', `Lighter holds no ${market.symbol} position`);
      if (here.side !== req.positionSide) return notSent('CLOSE_POSITION_MISMATCH:SIDE', `Lighter holds ${here.side} ${here.size} ${market.symbol}, TrendPilot closes ${req.positionSide}`);
      const baseAmount = toScaledInt(Decimal.min(req.contracts, here.size), market.sizeDecimals, 'DOWN');
      if (D(baseAmount).lte(0)) return notSent('REDUCE_ONLY_NO_POSITION', `position ${here.size} is below one size step`);
      const book = await freshBook(market.marketId);
      if (typeof book === 'string') return notSent('LIGHTER_BOOK_UNAVAILABLE', book);
      const isAsk = req.positionSide === 'LONG';
      const order = buildReduceOnlyClose({ positionSide: req.positionSide, marketId: market.marketId, baseAmount, worstPrice: worstPrice(isAsk, isAsk ? book.bid : book.ask, o.inputs.closeWorstPricePct!, market.priceDecimals), clientOrderIndex: 0 });
      const row = existing ?? (await prepare({ clientOrderId: req.clientOrderId, purpose: 'CLOSE', marketId: market.marketId, txType: LIGHTER_TX_TYPE.CREATE_ORDER, request: {} }));
      const request: LighterOrderReq = { ...order, ClientOrderIndex: row.clientOrderIndex };
      await patch(row.id, { request: request as unknown as Record<string, unknown> });
      const diagnostics: VenueDiagnostics = { request: { method: 'POST', path: '/api/v1/sendTx', body: { txType: LIGHTER_TX_TYPE.CREATE_ORDER, order: request }, context: { position: { side: here.side, size: here.size }, book, requestedContracts: D(req.contracts).toFixed() } } };
      const sent = await send((await rowFor(req.clientOrderId))!, (n) => signer.signCreateOrder(request, n), false);
      if (!sent.ok) return reject(sent.reason, { ...diagnostics, response: { code: sent.code, message: sent.message } });
      const res = await closeResult((await rowFor(req.clientOrderId))!, market);
      const after = await snapshot()
        .then((s) => s.positions.find((p) => p.marketId === market.marketId)?.size ?? '0')
        .catch(() => null);
      return { ...res, diagnostics: { ...diagnostics, response: { code: 200, message: 'accepted', positionAfter: after } } };
    },

    async lookupCloseOrder(clientOrderId, instrumentId) {
      const row = await rowFor(clientOrderId);
      if (!row || row.state === 'PREPARED') return null;
      const market = await o.marketFor(instrumentId);
      if (row.state === 'API_REJECTED' || row.state === 'FAILED') return { status: 'REJECTED', orderId: '', clientOrderId, reason: `LIGHTER_${String((row.response as { code?: unknown }).code ?? row.state)}` };
      if ((UNCERTAIN_STATES as readonly string[]).includes(row.state) && (await reconcileSend(row, (n) => signer.signCreateOrder(row.request as LighterOrderReq, n))) === 'FAILED')
        return { status: 'REJECTED', orderId: '', clientOrderId, reason: 'LIGHTER_TX_FAILED' };
      return closeResult((await rowFor(clientOrderId))!, market);
    },

    async resizeProtection(stopOrderId, contracts, instrumentId) {
      const market = await o.marketFor(instrumentId);
      if (!(await resizeStop(stopOrderId, contracts, market))) throw new LighterPrivateError(`stop ${stopOrderId} not resized to ${contracts}`, 'REFUSED');
      return stopOrderId;
    },

    async cancelOrder() {
      // Not sent in this step: a reduce-only stop left on a flat market cannot open exposure, and
      // new entries are refused while any order rests on that market. Sync reports it (STOP_ORPHANED).
    },

    async position(_account, instrumentId, _tx, side) {
      const market = await o.marketFor(instrumentId);
      const here = (await snapshot()).positions.find((p) => p.marketId === market.marketId);
      const held = here && D(here.size).gt(0) ? { side: here.side, contracts: here.size } : { side: null, contracts: '0' };
      if (side) return held.side === side ? held : { side: null, contracts: '0' };
      return held;
    },

    async stopOrderIdFor(ref) {
      return parseStopRef(ref) ? ref : null;
    }
  };
}
