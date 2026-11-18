import { bitunixAccountView, connectionDto, connectionFor, getDb, revokeConnection, revokeLighterConnection, saveBitunixConnection, saveConnection, saveLighterConnection } from '@trendpilot/db';
import { json, readJson, route } from '@/server/http';
import { connectionExchangeOf } from '@/server/exchange';
import { lighterAccountView } from '@/server/live';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * GET [?exchange=MEXC|BITUNIX|LIGHTER]: the investor's own connection to that exchange (default
 * MEXC): status, fingerprint, verification. Never the key or secret.
 */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const exchange = connectionExchangeOf(req);
  const db = getDb();
  const c = await connectionFor(db, user.id, exchange);
  const active = c && c.status !== 'REVOKED' ? c : null;
  // Bitunix / Lighter: the account as last reconciled (positions, balance, sync health).
  const account = exchange === 'BITUNIX' ? { account: active ? await bitunixAccountView(db, active) : null } : exchange === 'LIGHTER' ? { account: active ? lighterAccountView(active) : null } : {};
  return json(correlationId, { connection: active ? connectionDto(active) : null, ...account });
});

/**
 * PUT { exchange?, ... }: saves (or replaces) the key for one exchange (default MEXC), sealed
 * server-side, and verifies it without sending any order.
 *  - MEXC / Bitunix: { accountRef, apiKey, secretKey }.
 *  - Lighter: { environment, accountIndex, apiKeyIndex, apiPrivateKey } — the API key's private key,
 *    never a wallet key or seed phrase. Lighter Live trading stays off in this release.
 */
export const PUT = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const b = (await readJson(req)) as Record<string, unknown>;
  const exchange = connectionExchangeOf(req, b);
  const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
  const sn = (k: string) => (typeof b[k] === 'number' ? String(b[k]) : s(k));
  const db = getDb();
  if (exchange === 'LIGHTER') {
    const c = await saveLighterConnection(db, user.id, { environment: s('environment'), accountIndex: sn('accountIndex'), apiKeyIndex: sn('apiKeyIndex'), apiPrivateKey: s('apiPrivateKey') }, correlationId);
    return json(correlationId, { connection: connectionDto(c), account: lighterAccountView(c) });
  }
  const input = { accountRef: s('accountRef'), apiKey: s('apiKey'), secretKey: s('secretKey') };
  const c = exchange === 'BITUNIX' ? await saveBitunixConnection(db, user.id, input, correlationId) : await saveConnection(db, user.id, input, correlationId);
  return json(correlationId, { connection: connectionDto(c) });
});

/**
 * DELETE [?exchange=]: removes the key. Refused while Live positions are open or Live orders are
 * unresolved on that exchange (Lighter: also while a signed send is still being confirmed).
 */
export const DELETE = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const exchange = connectionExchangeOf(req);
  const c = exchange === 'LIGHTER' ? await revokeLighterConnection(getDb(), user.id, correlationId) : await revokeConnection(getDb(), user.id, correlationId, exchange);
  return json(correlationId, { connection: connectionDto(c) });
});
