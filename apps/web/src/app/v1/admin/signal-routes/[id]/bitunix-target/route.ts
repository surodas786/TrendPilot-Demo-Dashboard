import { getDb, setBitunixRouteTarget } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import { json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * PUT { instrumentId: string | null, enabled?: boolean }: sets, disables or (null) removes the
 * route's explicit Bitunix target — the same contract on Bitunix, which then also receives this
 * route's accepted alerts. The route's own (MEXC) contract and its blocks are unchanged.
 */
export const PUT = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  const b = (await readJson(req)) as Record<string, unknown>;
  if (b.instrumentId !== null && typeof b.instrumentId !== 'string') throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'instrumentId must be a Bitunix instrument id or null.');
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'enabled must be true or false.');
  const target = await setBitunixRouteTarget(getDb(), user.id, params.id, { instrumentId: (b.instrumentId as string | null) ?? null, enabled: b.enabled as boolean | undefined }, correlationId);
  return json(correlationId, { target });
});
