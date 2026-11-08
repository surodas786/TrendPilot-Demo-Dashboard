import { randomUUID } from 'node:crypto';
import { getDb, ingestTradingViewSignal, PersistenceError } from '@trendpilot/db';
import { now } from '@/server/clock';
import { hitLimit } from '@/server/rateLimit';

export const dynamic = 'force-dynamic';

/** TradingView alert bodies are small; anything larger is not a valid alert. */
const MAX_BODY_BYTES = 8 * 1024;

const respond = (correlationId: string, status: number, body: unknown) =>
  new Response(JSON.stringify({ ...(body as object), correlationId }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-correlation-id': correlationId }
  });

/**
 * SIG-01 `POST /v1/webhooks/tradingview/{ingressToken}`.
 * - The token is never logged, echoed or stored (only its hash exists in the database).
 * - TradingView sends JSON as application/json or text/plain; both are accepted.
 * - 202 is returned only after the event and its dispatch job are committed together.
 */
export async function POST(req: Request, ctx: { params: Promise<{ ingressToken: string }> }): Promise<Response> {
  const receivedAt = now();
  const correlationId = randomUUID();
  const { ingressToken } = await ctx.params;

  // Coarse abuse limit keyed by a non-secret token prefix (not the token itself).
  if (hitLimit(`webhook:${ingressToken.slice(0, 12)}`, receivedAt.getTime(), 600, 60_000)) {
    return respond(correlationId, 429, { status: 'rejected', reason: 'RATE_LIMITED', message: 'Too many requests.' });
  }

  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return respond(correlationId, 413, { status: 'rejected', reason: 'MALFORMED', message: 'Alert body is too large.' });
  const body = await req.text();
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return respond(correlationId, 413, { status: 'rejected', reason: 'MALFORMED', message: 'Alert body is too large.' });

  try {
    const result = await ingestTradingViewSignal(getDb(), { token: ingressToken, body, receivedAt, correlationId });
    return respond(correlationId, result.httpStatus, result.body);
  } catch (e) {
    // SIG-05: never acknowledge an event that is not durable. TradingView may retry.
    const kind = e instanceof PersistenceError ? 'persistence' : 'unexpected';
    console.error(`[webhook ${correlationId}] ${kind} failure`, e instanceof Error ? e.name : 'error');
    return respond(correlationId, 503, { status: 'error', reason: 'PERSISTENCE_UNAVAILABLE', message: 'The signal could not be stored. Retry later.' });
  }
}
