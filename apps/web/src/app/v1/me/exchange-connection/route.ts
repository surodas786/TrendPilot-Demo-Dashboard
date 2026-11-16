import { connectionDto, connectionFor, getDb, revokeConnection, saveBitunixConnection, saveConnection } from '@trendpilot/db';
import { json, readJson, route } from '@/server/http';
import { exchangeOf } from '@/server/exchange';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * GET [?exchange=MEXC|BITUNIX]: the investor's own connection to that exchange (default MEXC):
 * status, fingerprint, verification. Never the key or secret.
 */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const exchange = exchangeOf(req);
  const c = await connectionFor(getDb(), user.id, exchange);
  return json(correlationId, { connection: c && c.status !== 'REVOKED' ? connectionDto(c) : null });
});

/**
 * PUT { exchange?, accountRef, apiKey, secretKey }: saves (or replaces) the API key for one exchange
 * (default MEXC), sealed server-side, and verifies it with read-only calls. MEXC: Live stays Off
 * until an administrator approves the account. Bitunix: read-only in this release.
 */
export const PUT = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const b = (await readJson(req)) as Record<string, unknown>;
  const exchange = exchangeOf(req, b);
  const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
  const input = { accountRef: s('accountRef'), apiKey: s('apiKey'), secretKey: s('secretKey') };
  const c = exchange === 'BITUNIX' ? await saveBitunixConnection(getDb(), user.id, input, correlationId) : await saveConnection(getDb(), user.id, input, correlationId);
  return json(correlationId, { connection: connectionDto(c) });
});

/** DELETE [?exchange=]: removes the key. MEXC: refused while Live positions are open or Live orders are unresolved. */
export const DELETE = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const c = await revokeConnection(getDb(), user.id, correlationId, exchangeOf(req));
  return json(correlationId, { connection: connectionDto(c) });
});
