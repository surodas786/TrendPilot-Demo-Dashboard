import { approveConnection, connectionDto, getDb } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import { json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** POST { maxOrderContracts, maxOrderNotionalUsdt, maxLeverage, maxExposureUsdt }: allowlists a verified account with its limits. */
export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  const b = (await readJson(req)) as Record<string, unknown>;
  const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : typeof b[k] === 'number' ? String(b[k]) : '');
  const lev = Number(b.maxLeverage);
  if (!Number.isFinite(lev)) throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'maxLeverage must be a number.');
  const c = await approveConnection(getDb(), user.id, params.id, { maxOrderContracts: s('maxOrderContracts'), maxOrderNotionalUsdt: s('maxOrderNotionalUsdt'), maxLeverage: lev, maxExposureUsdt: s('maxExposureUsdt') }, correlationId);
  return json(correlationId, { connection: connectionDto(c) });
});
