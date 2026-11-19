import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { exchangeAccountEvents, fills, instruments, jobs, orderIntents, paperAccounts, positions } from '../schema';
import { noteAttempt, PAPER_SUBMIT_JOB, recordOpeningOutcome, releaseIntent } from '../paper/entry';
import type { SimResult } from '../paper/simulator';
import { readHistoryOrders, readPendingOrders } from './bitunixAccount';
import { bitunixVenue, type BitunixOrderRequester } from './bitunixOrders';
import { BitunixPrivateError, type BitunixRequester } from './bitunixPrivate';
import type { ConnectionRow } from './liveMode';
import { UncertainSubmissionError } from './mexcVenue';

/**
 * Exchange reconciliation of unresolved Bitunix Live ENTRY intents, outside their submit job.
 *
 * The submit job (paper.submit) is retried at most `max_attempts` times. When every attempt fails
 * (an uncertain response, a lookup error, fills not listed yet), the job goes DEAD and nothing else
 * used to look at the intent again: it stayed SUBMITTING with its reservation held, while the
 * private sync only mirrored balances, positions and order pushes. This is the one path that
 * settles such an intent, used by the scheduled/manual REST sync, by private order pushes (via the
 * sync they queue) and by the ops recovery CLI:
 *
 *  - Lookup by the intent's ORIGINAL client ID (never a new one), with bounded retries for delayed
 *    visibility. A final order is booked through the same `recordOpeningOutcome` the job uses
 *    (fills from Bitunix trade history, the leg's positionId, the attached stop verified), under the
 *    intent row lock: whichever of the job, the sync or a repeated run gets there first books it,
 *    the others find it resolved. Fills, positions and ledger rows are keyed, so nothing doubles.
 *  - An order that exists but is not final, or whose fills are not listed yet, stays unresolved.
 *  - Absence counts only as confirmed non-acceptance when ALL hold: get_order_detail by client ID
 *    finds nothing (after the retries), neither the open orders nor the order history for the
 *    symbol since the intent was created list that client ID, no private order push for it was
 *    ever received, the exchange order ID was never learned, the submission is older than the
 *    visibility window, and the submit job is no longer active. Only then is the intent EXPIRED
 *    with RECONCILED_NOT_AT_VENUE and its reservation released, in one transaction (the existing
 *    recovery rule, as in scripts/ops/2026-11-13-reconcile-xau-live-intents.sql).
 *  - Any read failure leaves the intent unresolved; the attempt is recorded on the intent.
 *
 * Reads only: the requester handed to the venue refuses every POST.
 */

export const BITUNIX_INTENT_VISIBILITY_MS = 10 * 60_000;
export const BITUNIX_INTENT_LOOKUP = { attempts: 3, delayMs: 1_500 };
const UNRESOLVED = ['SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'] as const;

export type IntentReconcileResult = {
  intentId: string;
  clientOrderId: string;
  stateBefore: string;
  /** FILLED / REJECTED: booked from exchange evidence. NOT_AT_VENUE: released. PENDING: still unresolved. */
  result: 'FILLED' | 'REJECTED' | 'NOT_AT_VENUE' | 'PENDING' | 'ALREADY_RESOLVED';
  exchangeOrderId: string | null;
  jobStatus: string | null;
  detail: string;
};

export interface ReconcileOptions {
  /** Only this client order ID (ops recovery). */
  clientOrderId?: string;
  /** false = report what would happen; nothing is written. Default true. */
  apply?: boolean;
  visibilityMs?: number;
  lookup?: { attempts: number; delayMs: number };
  sleep?: (ms: number) => Promise<void>;
  /** Venue confirmation polling (tests). */
  confirm?: { attempts: number; delayMs: number };
}

/** The venue's order-changing method is never reachable from reconciliation. */
const readOnly = (r: BitunixRequester): BitunixOrderRequester & { accountTag?: string | null } => ({
  accountTag: (r as { accountTag?: string | null }).accountTag ?? null,
  get: (path, params) => r.get(path, params),
  post: async (path) => {
    throw new BitunixPrivateError(`Refusing POST ${path}: reconciliation is read-only`, 'REFUSED');
  }
});

export async function reconcileBitunixIntents(db: Db, conn: ConnectionRow, r: BitunixRequester, now: Date, o: ReconcileOptions = {}): Promise<IntentReconcileResult[]> {
  if (conn.exchange !== 'BITUNIX') return [];
  const apply = o.apply !== false;
  const sleep = o.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
  const lookup = o.lookup ?? BITUNIX_INTENT_LOOKUP;
  const visibilityMs = o.visibilityMs ?? BITUNIX_INTENT_VISIBILITY_MS;

  // The connection owner's Bitunix Live entries that are still unresolved.
  const rows = await db
    .select({ i: orderIntents, symbol: instruments.exchangeSymbol })
    .from(orderIntents)
    .innerJoin(paperAccounts, eq(paperAccounts.id, orderIntents.paperAccountId))
    .innerJoin(instruments, eq(instruments.id, orderIntents.instrumentId))
    .where(
      and(
        eq(orderIntents.ownerId, conn.ownerId),
        eq(paperAccounts.ownerId, conn.ownerId),
        eq(paperAccounts.exchange, 'BITUNIX'),
        eq(paperAccounts.mode, 'LIVE'),
        eq(orderIntents.mode, 'LIVE'),
        eq(orderIntents.kind, 'OPEN'),
        inArray(orderIntents.state, [...UNRESOLVED]),
        ...(o.clientOrderId ? [eq(orderIntents.clientOrderId, o.clientOrderId)] : [])
      )
    )
    .orderBy(asc(orderIntents.createdAt));
  if (!rows.length) return [];

  const venue = bitunixVenue({
    requester: readOnly(r),
    contractFor: async (instrumentId) => {
      const [i] = await db.select().from(instruments).where(eq(instruments.id, instrumentId));
      if (!i || i.exchange !== 'BITUNIX' || !i.exchangeSymbol) throw new Error(`instrument ${instrumentId} is not a Bitunix contract`);
      return { symbol: i.exchangeSymbol, qtyStep: i.qtyStep, minQty: i.minQty, maxQty: i.maxQty, priceTick: i.priceTick, takerFeeRate: i.takerFeeRate };
    },
    ...(o.confirm ? { confirm: o.confirm, sleep: async () => {} } : {})
  });

  const out: IntentReconcileResult[] = [];
  for (const { i: intent, symbol } of rows) {
    const [job] = await db.select().from(jobs).where(eq(jobs.dedupeKey, `${PAPER_SUBMIT_JOB}:${intent.id}`));
    // The job still owns the order while it can run again (pending retry or a live lease).
    const jobActive = !!job && (job.status === 'PENDING' || (job.status === 'RUNNING' && !!job.claimExpiresAt && job.claimExpiresAt > now));
    const base = { intentId: intent.id, clientOrderId: intent.clientOrderId, stateBefore: intent.state, jobStatus: job ? `${job.status} (${job.attempts}/${job.maxAttempts})` : null };
    const finish = async (r: Omit<IntentReconcileResult, keyof typeof base>, write: boolean) => {
      out.push({ ...base, ...r });
      if (!apply || !write) return;
      await db
        .update(orderIntents)
        .set({
          reconcileAttempts: sql`${orderIntents.reconcileAttempts} + 1`,
          lastReconcileAt: now,
          lastReconcileNote: `${now.toISOString()} ${r.result}: ${r.detail}`.slice(0, 500),
          ...(r.exchangeOrderId ? { exchangeOrderId: sql`coalesce(${orderIntents.exchangeOrderId}, ${r.exchangeOrderId})` } : {}),
          updatedAt: sql`now()`
        })
        .where(eq(orderIntents.id, intent.id));
    };

    // 1. By the original client ID, with bounded retries for delayed visibility.
    let sim: SimResult | null = null;
    let uncertain: string | null = null;
    let readError: string | null = null;
    for (let a = 0; a < lookup.attempts; a++) {
      try {
        sim = await venue.lookupOrder(intent.clientOrderId, intent.instrumentId);
        uncertain = null;
        readError = null;
      } catch (e) {
        if (e instanceof UncertainSubmissionError) uncertain = e.message;
        else readError = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 300);
      }
      if (sim) break;
      if (a < lookup.attempts - 1) await sleep(lookup.delayMs);
    }

    if (sim) {
      if (!apply) {
        await finish({ result: sim.status, exchangeOrderId: sim.orderId || null, detail: sim.status === 'FILLED' ? `Bitunix order ${sim.orderId} FILLED ${sim.fill.contracts} @ ${sim.fill.price}, fee ${sim.fill.fee}; position ${sim.positionRef ?? '?'}, stop ${sim.stop.orderId} (dry run)` : `Bitunix order ${sim.orderId || '-'} ${sim.reason} (dry run)` }, false);
        continue;
      }
      try {
        const done = await recordOpeningOutcome(db, null, intent, sim, now, true, venue);
        const booked = done.state === 'FILLED' || done.state === 'REJECTED';
        await finish(
          {
            result: booked && done.state === sim.status ? sim.status : 'ALREADY_RESOLVED',
            exchangeOrderId: sim.orderId || null,
            detail:
              sim.status === 'FILLED'
                ? `Bitunix order ${sim.orderId} FILLED ${sim.fill.contracts} @ ${sim.fill.price}, fee ${sim.fill.fee}; position ${sim.positionRef ?? '?'}, stop ${sim.stop.orderId}${done.reason ? ` (${done.reason})` : ''}`
                : `Bitunix order ${sim.orderId || '-'} ${sim.reason}; reservation released`
          },
          true
        );
      } catch (e) {
        await noteAttempt(db, intent.id, e, now);
        out.push({ ...base, result: 'PENDING', exchangeOrderId: sim.orderId || null, detail: `booking failed: ${(e as Error).message}`.slice(0, 300) });
      }
      continue;
    }
    if (uncertain) {
      await finish({ result: 'PENDING', exchangeOrderId: intent.exchangeOrderId, detail: `Bitunix holds the order but it is not final or its fills are not listed yet (${uncertain.slice(0, 200)})` }, true);
      continue;
    }
    if (readError) {
      await finish({ result: 'PENDING', exchangeOrderId: intent.exchangeOrderId, detail: `lookup by clientId failed: ${readError}` }, true);
      continue;
    }

    // 2. Not found by client ID: every other piece of evidence must agree before it counts as absent.
    let listed: { orderId: string; status: string } | null = null;
    try {
      // No time bounds: the clientId is the match, and a window derived from TrendPilot's clock could
      // exclude the row under clock skew. The newest 2000 orders of the symbol are read.
      // Every row counts here, including rows Bitunix tags with a subAccountId (on production it tags
      // the investor's own history rows that way): a row carrying this TrendPilot clientId is evidence.
      // Rows that fail to parse are collected, not fatal; one that could be this order (same clientId,
      // or no clientId to tell) keeps the search incomplete, so absence is never concluded over it.
      const opts = { maxPages: 20, includeSubAccountRows: true, collectRowErrors: true };
      const pendingRead = await readPendingOrders(r, opts);
      const historyRead = await readHistoryOrders(r, { symbol }, opts);
      const hit = [...pendingRead.items, ...historyRead.items].find((x) => x.clientId === intent.clientOrderId);
      if (hit) listed = { orderId: hit.orderId, status: hit.status };
      const blocking = [...(pendingRead.skipped ?? []), ...(historyRead.skipped ?? [])].filter((k) => k.clientId === null || k.clientId === intent.clientOrderId);
      if (!hit && blocking.length) {
        await finish({ result: 'PENDING', exchangeOrderId: intent.exchangeOrderId, detail: `order list incomplete: ${blocking.length} unparseable row(s) could be this order (${blocking.map((k) => `order ${k.orderId ?? '?'}: ${k.error}`).join('; ').slice(0, 250)})` }, true);
        continue;
      }
    } catch (e) {
      await finish({ result: 'PENDING', exchangeOrderId: intent.exchangeOrderId, detail: `get_order_detail empty; order list read failed: ${(e as Error).message}`.slice(0, 300) }, true);
      continue;
    }
    if (listed) {
      await finish({ result: 'PENDING', exchangeOrderId: listed.orderId, detail: `get_order_detail by clientId is empty but Bitunix lists order ${listed.orderId} (${listed.status}) with this clientId; left unresolved` }, true);
      continue;
    }
    const [pushed] = await db
      .select({ orderId: exchangeAccountEvents.exchangeOrderId, source: exchangeAccountEvents.source })
      .from(exchangeAccountEvents)
      .where(and(eq(exchangeAccountEvents.connectionId, conn.id), eq(exchangeAccountEvents.kind, 'ORDER'), sql`${exchangeAccountEvents.detail}->>'clientId' = ${intent.clientOrderId}`))
      .limit(1);
    const since = intent.submittedAt ?? intent.createdAt;
    const waited = now.getTime() - since.getTime();
    const blockers = [
      pushed ? `Bitunix reported this clientId to TrendPilot before (order ${pushed.orderId}, ${pushed.source === 'WS' ? 'private WebSocket push' : 'REST order mirror'})` : null,
      intent.exchangeOrderId ? `its Bitunix order ID ${intent.exchangeOrderId} is known` : null,
      waited < visibilityMs ? `submitted ${Math.round(waited / 1000)} s ago (visibility window ${Math.round(visibilityMs / 1000)} s)` : null,
      jobActive ? `its submit job is still ${job!.status}` : null
    ].filter(Boolean);
    if (blockers.length) {
      await finish({ result: 'PENDING', exchangeOrderId: intent.exchangeOrderId ?? pushed?.orderId ?? null, detail: `not found by clientId, open orders or history; not released because ${blockers.join('; ')}` }, true);
      continue;
    }
    const reason = `RECONCILED_NOT_AT_VENUE: Bitunix has no order with clientId ${intent.clientOrderId} (detail lookup x${lookup.attempts}, open orders and the latest ${symbol} order history checked ${now.toISOString()}); never accepted`;
    if (!apply) {
      await finish({ result: 'NOT_AT_VENUE', exchangeOrderId: null, detail: `${reason} (dry run: would expire the intent and release ${intent.reservedUsdt} USDT)` }, false);
      continue;
    }
    const released = await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(orderIntents).where(eq(orderIntents.id, intent.id)).for('update');
      if (!cur || !(UNRESOLVED as readonly string[]).includes(cur.state) || cur.exchangeOrderId) return false;
      const [f] = await tx.select({ id: fills.id }).from(fills).where(eq(fills.intentId, cur.id)).limit(1);
      const [p] = await tx.select({ id: positions.id }).from(positions).where(eq(positions.openIntentId, cur.id)).limit(1);
      if (f || p) return false;
      await releaseIntent(tx, cur, 'EXPIRED', reason, now);
      return true;
    });
    await finish({ result: released ? 'NOT_AT_VENUE' : 'ALREADY_RESOLVED', exchangeOrderId: null, detail: released ? `${reason}; reservation ${intent.reservedUsdt} USDT released` : 'resolved meanwhile; nothing changed' }, true);
  }
  return out;
}

/** NEW < PART_FILLED < final. A final status is never replaced by an earlier one, whatever its timestamp. */
export const BITUNIX_ORDER_STATUS_RANK: Record<string, number> = { NEW: 1, PART_FILLED: 2, FILLED: 3, CANCELED: 3, CANCELLED: 3, PART_FILLED_CANCELED: 3, EXPIRED: 3 };
export const bitunixStatusRank = (s: string | null | undefined): number => (s ? (BITUNIX_ORDER_STATUS_RANK[s.toUpperCase()] ?? 0) : 0);

/**
 * A private order push for one of the connection owner's intents (matched by connection owner +
 * clientId): the exchange order ID is kept with the intent (first value wins) and the reported
 * status advances only forward (NEW → PART_FILLED → final). A push with an EARLIER status than the
 * one stored (Bitunix may send NEW after FILLED, even with a later timestamp) changes nothing and is
 * reported as a conflict, which the caller settles through REST. Returns null for any other order.
 */
export async function noteBitunixOrderPush(
  db: Db,
  conn: Pick<ConnectionRow, 'id' | 'ownerId'>,
  e: { clientId: string | null; orderId: string; status: string; dealAmount: string | null; mtimeMs: number | null },
  now: Date
): Promise<{ intentId: string; unresolved: boolean; advanced: boolean; conflict: boolean } | null> {
  if (!e.clientId) return null;
  return db.transaction(async (tx) => {
    const [hit] = await tx
      .select({ id: orderIntents.id, state: orderIntents.state, status: orderIntents.exchangeOrderStatus, orderId: orderIntents.exchangeOrderId })
      .from(orderIntents)
      .innerJoin(paperAccounts, eq(paperAccounts.id, orderIntents.paperAccountId))
      .where(and(eq(orderIntents.clientOrderId, e.clientId!), eq(orderIntents.ownerId, conn.ownerId), eq(paperAccounts.ownerId, conn.ownerId), eq(paperAccounts.exchange, 'BITUNIX'), eq(orderIntents.mode, 'LIVE')))
      .for('update', { of: orderIntents });
    if (!hit) return null;
    const unresolved = (['INTENT', ...UNRESOLVED] as readonly string[]).includes(hit.state);
    const before = bitunixStatusRank(hit.status);
    const after = bitunixStatusRank(e.status);
    const advanced = after > before;
    // Same rank but a different final status (FILLED vs CANCELED) or another order ID: REST decides.
    const conflict = after < before || (after === before && after === 3 && hit.status !== e.status.toUpperCase()) || (!!hit.orderId && hit.orderId !== e.orderId);
    await tx
      .update(orderIntents)
      .set({
        exchangeOrderId: sql`coalesce(${orderIntents.exchangeOrderId}, ${e.orderId})`,
        ...(advanced ? { exchangeOrderStatus: e.status.toUpperCase(), exchangeOrderStatusAt: e.mtimeMs ? new Date(e.mtimeMs) : now } : {}),
        ...(unresolved && (advanced || conflict)
          ? { lastReconcileNote: `${now.toISOString()} WS order ${e.orderId} ${e.status}${e.dealAmount && Number(e.dealAmount) > 0 ? ` filled ${e.dealAmount}` : ''}${e.mtimeMs ? ` (exchange ${new Date(e.mtimeMs).toISOString()})` : ''}${conflict ? ` — conflicts with stored ${hit.status ?? '-'}${hit.orderId && hit.orderId !== e.orderId ? ` / order ${hit.orderId}` : ''}; REST decides` : ''}`.slice(0, 500) }
          : {}),
        updatedAt: sql`now()`
      })
      .where(eq(orderIntents.id, hit.id));
    return { intentId: hit.id, unresolved, advanced, conflict };
  });
}
