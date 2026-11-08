import { and, eq, gt, sql } from 'drizzle-orm';
import {
  assessTiming,
  isDirectional,
  normalizeSource,
  oppositeAction,
  streamKey,
  tradingViewPayloadSchema,
  type SignalRejectReason,
  type TradingViewPayload
} from '@trendpilot/domain';
import type { Db } from '../client';
import { enqueueJob } from '../jobs';
import { signalEvents, signalRejections, signalRoutes } from '../schema';
import { verifyIngressToken, type IngressRow } from './ingress';

/**
 * SIG-01…SIG-05 intake. Validates, routes, deduplicates and orders a TradingView alert, then
 * stores the accepted event and its dispatch job atomically. No exchange calls happen here.
 *
 * HTTP mapping (SIG-05): 202 accepted after commit · 200 duplicate of an accepted event ·
 * 400 malformed · 404 invalid ingress · 422 unrecognised or unprocessable · 503 persistence failure.
 */

export const SIGNAL_DISPATCH_JOB = 'signal.dispatch';

export type IntakeResult =
  | { httpStatus: 202; body: { status: 'accepted'; eventId: string; disposition: 'DISPATCH' | 'INFO_ONLY' } }
  | { httpStatus: 200; body: { status: 'duplicate'; eventId: string } }
  | { httpStatus: 400 | 404 | 422; body: { status: 'rejected'; reason: SignalRejectReason | 'INVALID_INGRESS'; message: string; issues?: { path: string; message: string }[] } };

export class PersistenceError extends Error {
  constructor(cause: unknown) {
    super('The signal could not be stored.');
    this.name = 'PersistenceError';
    this.cause = cause;
  }
}

const isUniqueViolation = (e: unknown) => {
  const code = (x: unknown) => (x && typeof x === 'object' && 'code' in x ? (x as { code: unknown }).code : undefined);
  return code(e) === '23505' || code((e as { cause?: unknown })?.cause) === '23505';
};

/** Non-secret, normalised view of the payload for rejection records. */
function redactedPayload(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const allowed = ['action', 'source_exchange', 'source_symbol', 'interval', 'bar_open_utc', 'alert_fired_utc', 'reference_price'];
  const out: Record<string, unknown> = {};
  for (const k of allowed) {
    const v = (raw as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = typeof v === 'string' ? v.slice(0, 64) : typeof v;
  }
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length) out._unexpectedKeys = extra.slice(0, 10).map((k) => k.slice(0, 40));
  return out;
}

async function reject(
  db: Db,
  ctx: { ingress: IngressRow | null; routeId?: string | null; receivedAt: Date; correlationId: string },
  httpStatus: 400 | 422,
  reason: SignalRejectReason,
  message: string,
  detail: Record<string, unknown>
): Promise<IntakeResult> {
  try {
    await db.insert(signalRejections).values({
      ingressNamespace: ctx.ingress?.namespace ?? null,
      routeId: ctx.routeId ?? null,
      reason,
      httpStatus,
      detail,
      receivedAt: ctx.receivedAt,
      correlationId: ctx.correlationId
    });
  } catch {
    // Recording a rejection is best-effort; the rejection itself stands.
  }
  return { httpStatus, body: { status: 'rejected', reason, message, ...(detail.issues ? { issues: detail.issues as { path: string; message: string }[] } : {}) } };
}

async function findDuplicate(db: Db, namespace: string, routeId: string, p: TradingViewPayload) {
  const [dup] = await db
    .select({ id: signalEvents.id })
    .from(signalEvents)
    .where(and(eq(signalEvents.ingressNamespace, namespace), eq(signalEvents.routeId, routeId), eq(signalEvents.barOpenAt, p.bar_open_utc), eq(signalEvents.action, p.action)));
  return dup?.id ?? null;
}

export async function ingestTradingViewSignal(db: Db, input: { token: string | undefined; body: string; receivedAt: Date; correlationId: string }): Promise<IntakeResult> {
  const { receivedAt, correlationId } = input;

  // SIG-01: the token identifies the ingress. Invalid tokens are not recorded (no amplification).
  let ingress: IngressRow | null;
  try {
    ingress = await verifyIngressToken(db, input.token);
  } catch (e) {
    throw new PersistenceError(e);
  }
  if (!ingress) return { httpStatus: 404, body: { status: 'rejected', reason: 'INVALID_INGRESS', message: 'Unknown webhook.' } };
  const ctx = { ingress, receivedAt, correlationId };

  // SIG-02/03: exact schema.
  let raw: unknown;
  try {
    raw = JSON.parse(input.body);
  } catch {
    return reject(db, ctx, 400, 'MALFORMED', 'The alert message is not valid JSON.', { length: input.body.length });
  }
  const parsed = tradingViewPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
    return reject(db, ctx, 400, 'MALFORMED', 'The alert message does not match the required template.', { issues, payload: redactedPayload(raw) });
  }
  const p = parsed.data;
  const exchange = normalizeSource(p.source_exchange);
  const symbol = normalizeSource(p.source_symbol);
  const payloadView = redactedPayload(raw);

  // SIG-04: resolve the approved route for the exact source tuple.
  const routes = await db
    .select()
    .from(signalRoutes)
    .where(
      and(
        eq(signalRoutes.ingressId, ingress.id),
        eq(signalRoutes.sourceExchange, exchange),
        eq(signalRoutes.sourceSymbol, symbol),
        eq(signalRoutes.interval, p.interval),
        eq(signalRoutes.action, p.action),
        eq(signalRoutes.enabled, true)
      )
    );
  if (routes.length === 0) return reject(db, ctx, 422, 'ROUTE_NOT_FOUND', `No approved route for ${exchange}:${symbol} ${p.interval}m ${p.action}.`, { payload: payloadView });
  if (routes.length > 1) return reject(db, ctx, 422, 'ROUTE_AMBIGUOUS', 'More than one route matches this source; nothing was dispatched.', { payload: payloadView });
  const route = routes[0]!;
  const rctx = { ...ctx, routeId: route.id };

  // A redelivery of an already-accepted event is a duplicate even if it now looks stale.
  const existing = await findDuplicate(db, ingress.namespace, route.id, p);
  if (existing) return { httpStatus: 200, body: { status: 'duplicate', eventId: existing } };

  const timing = assessTiming(p, receivedAt, { maxSignalAgeSeconds: route.maxSignalAgeSeconds, clockToleranceSeconds: route.clockToleranceSeconds });
  if (!timing.ok) return reject(db, rctx, 422, timing.reason, timing.message, { payload: payloadView });
  const { times } = timing;
  const stream = streamKey(exchange, symbol, p.interval);
  const disposition = route.kind === 'INFO_ONLY' ? 'INFO_ONLY' : 'DISPATCH';

  type TxOutcome = { kind: 'accepted'; eventId: string } | { kind: 'duplicate'; eventId: string } | { kind: 'reject'; reason: SignalRejectReason; message: string };
  let outcome: TxOutcome;
  try {
    outcome = await db.transaction(async (tx) => {
      // Serialise intake per signal stream so ordering and same-bar checks see a consistent view.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`signal-stream:${ingress.namespace}:${stream}`}))`);

      const [dup] = await tx
        .select({ id: signalEvents.id })
        .from(signalEvents)
        .where(and(eq(signalEvents.ingressNamespace, ingress.namespace), eq(signalEvents.routeId, route.id), eq(signalEvents.barOpenAt, times.barOpenAt), eq(signalEvents.action, p.action)));
      if (dup) return { kind: 'duplicate', eventId: dup.id } as const;

      if (disposition === 'DISPATCH' && isDirectional(p.action)) {
        // SIG-05 bar watermark: a directional decision never goes backwards in time.
        const [newer] = await tx
          .select({ id: signalEvents.id })
          .from(signalEvents)
          .where(
            and(
              eq(signalEvents.ingressNamespace, ingress.namespace),
              eq(signalEvents.streamKey, stream),
              eq(signalEvents.disposition, 'DISPATCH'),
              sql`${signalEvents.action} IN ('BULLISH_FLIP', 'BEARISH_FLIP')`,
              gt(signalEvents.barOpenAt, times.barOpenAt)
            )
          )
          .limit(1);
        if (newer) return { kind: 'reject', reason: 'OUT_OF_ORDER', message: 'A newer bar was already accepted for this chart; older directional signals are rejected.' } as const;

        // Conflicting same-bar flip: the first accepted flip for a bar wins; the opposite one is rejected
        // so one position can never be opened twice (or both ways) from the same bar.
        const [conflict] = await tx
          .select({ id: signalEvents.id })
          .from(signalEvents)
          .where(
            and(
              eq(signalEvents.ingressNamespace, ingress.namespace),
              eq(signalEvents.streamKey, stream),
              eq(signalEvents.barOpenAt, times.barOpenAt),
              eq(signalEvents.action, oppositeAction(p.action)!),
              eq(signalEvents.disposition, 'DISPATCH')
            )
          )
          .limit(1);
        if (conflict) return { kind: 'reject', reason: 'CONFLICTING_SAME_BAR', message: 'The opposite flip was already accepted for this bar.' } as const;
      }

      const [event] = await tx
        .insert(signalEvents)
        .values({
          ingressNamespace: ingress.namespace,
          routeId: route.id,
          streamKey: stream,
          action: p.action,
          sourceExchange: exchange,
          sourceSymbol: symbol,
          interval: p.interval,
          instrumentId: route.instrumentId,
          packageId: route.packageId,
          barOpenAt: times.barOpenAt,
          barCloseAt: times.barCloseAt,
          alertFiredAt: times.alertFiredAt,
          receivedAt: times.receivedAt,
          referencePrice: p.reference_price,
          disposition,
          correlationId
        })
        .returning({ id: signalEvents.id });
      // ARC-01: the dispatch job commits with the event, or neither exists.
      if (disposition === 'DISPATCH') {
        await enqueueJob(tx, { kind: SIGNAL_DISPATCH_JOB, dedupeKey: `${SIGNAL_DISPATCH_JOB}:${event!.id}`, payload: { eventId: event!.id, correlationId }, runAfter: times.receivedAt });
      }
      return { kind: 'accepted', eventId: event!.id } as const;
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const id = await findDuplicate(db, ingress.namespace, route.id, p);
      if (id) return { httpStatus: 200, body: { status: 'duplicate', eventId: id } };
    }
    throw new PersistenceError(e);
  }

  if (outcome.kind === 'duplicate') return { httpStatus: 200, body: { status: 'duplicate', eventId: outcome.eventId } };
  if (outcome.kind === 'reject') return reject(db, rctx, 422, outcome.reason, outcome.message, { payload: payloadView });
  return { httpStatus: 202, body: { status: 'accepted', eventId: outcome.eventId, disposition } };
}
