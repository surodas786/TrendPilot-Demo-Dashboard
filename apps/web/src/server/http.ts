import { randomUUID } from 'node:crypto';
import { DomainError, ErrorCode, parseWith, type Issue } from '@trendpilot/domain';

const MAX_BODY_BYTES = 32 * 1024;

export interface RouteContext<P> {
  correlationId: string;
  params: P;
}

const baseHeaders = (correlationId: string): Record<string, string> => ({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-correlation-id': correlationId
});

export function json(correlationId: string, data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...baseHeaders(correlationId), ...headers } });
}

export function empty(correlationId: string, status = 204, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store', 'x-correlation-id': correlationId, ...headers } });
}

/** §10.1 structured error body: {code, message, correlationId} (+ field issues). */
export function errorResponse(correlationId: string, err: DomainError): Response {
  const body: { code: string; message: string; correlationId: string; issues?: Issue[]; details?: Record<string, unknown> } = {
    code: err.code,
    message: err.message,
    correlationId
  };
  if (err.issues?.length) body.issues = err.issues;
  if (err.details) body.details = err.details;
  return json(correlationId, body, err.status);
}

export const validationError = (issues: Issue[]) => new DomainError(400, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', issues);

/**
 * Same-origin guard for state-changing requests. Session cookies are SameSite=Lax;
 * this additionally rejects cross-site browser requests that carry an Origin header.
 */
function assertSameOrigin(req: Request): void {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.get('origin');
  if (!origin) return;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = '';
  }
  if (originHost !== host) throw new DomainError(403, ErrorCode.FORBIDDEN, 'Cross-origin request rejected.');
}

/** Reads a bounded JSON body. */
export async function readJson(req: Request): Promise<unknown> {
  const type = req.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'Send the request body as application/json.');
  }
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new DomainError(413, ErrorCode.PAYLOAD_TOO_LARGE, 'Request body is too large.');
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'Request body is not valid JSON.');
  }
}

/** Parses `If-Match: "3"` (or W/"3", or 3) into a revision number. */
export function requireRevision(req: Request): number {
  const raw = req.headers.get('if-match');
  if (!raw) throw new DomainError(428, ErrorCode.REVISION_REQUIRED, 'Send the current revision in the If-Match header.');
  const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(raw.trim());
  if (!m) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'If-Match must contain a revision number.');
  return Number(m[1]);
}

export const etag = (revision: number) => `"${revision}"`;

type Handler<P> = (req: Request, ctx: RouteContext<P>) => Promise<Response>;

/**
 * Wraps a route handler: assigns a correlation ID, applies the same-origin guard and
 * converts DomainErrors to structured responses. Unexpected errors never leak details.
 */
export function route<P = Record<string, string>>(handler: Handler<P>) {
  return async (req: Request, next?: { params: Promise<P> }): Promise<Response> => {
    const correlationId = randomUUID();
    try {
      assertSameOrigin(req);
      const params = (next ? await next.params : {}) as P;
      return await handler(req, { correlationId, params });
    } catch (e) {
      if (e instanceof DomainError) return errorResponse(correlationId, e);
      console.error(`[${correlationId}] unhandled error`, e);
      return errorResponse(correlationId, new DomainError(500, ErrorCode.INTERNAL, 'Something went wrong.'));
    }
  };
}

/** Reads and validates a JSON body against a domain schema, or throws 400 with field issues. */
export async function parseBody<T>(req: Request, schema: Parameters<typeof parseWith<T>>[0]): Promise<T> {
  const r = parseWith(schema, await readJson(req));
  if (!r.ok) throw validationError(r.issues);
  return r.value;
}
