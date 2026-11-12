import { connectionDto, connectionFor, getDb, revokeConnection, saveConnection } from '@trendpilot/db';
import { json, readJson, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** GET: the investor's own MEXC connection (status, fingerprint, verification). Never the key or secret. */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const c = await connectionFor(getDb(), user.id);
  return json(correlationId, { connection: c && c.status !== 'REVOKED' ? connectionDto(c) : null });
});

/**
 * PUT { accountRef, apiKey, secretKey }: saves (or replaces) the MEXC API key, sealed server-side,
 * and verifies it with read-only calls. Live stays Off; an administrator must approve the account.
 */
export const PUT = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const b = (await readJson(req)) as Record<string, unknown>;
  const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
  const c = await saveConnection(getDb(), user.id, { accountRef: s('accountRef'), apiKey: s('apiKey'), secretKey: s('secretKey') }, correlationId);
  return json(correlationId, { connection: connectionDto(c) });
});

/** DELETE: removes the key. Refused while Live positions are open or Live orders are unresolved. */
export const DELETE = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const c = await revokeConnection(getDb(), user.id, correlationId);
  return json(correlationId, { connection: connectionDto(c) });
});
