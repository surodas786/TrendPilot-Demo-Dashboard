import { createPilot, getDb, openPilot, pilotReadiness } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import { json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** GET: the open live pilot (if any) and its readiness. Live order submission is disabled in this build. */
export const GET = route(async (req, { correlationId }) => {
  await requireAdmin(req);
  const p = await openPilot(getDb());
  return json(correlationId, { pilot: p, readiness: pilotReadiness(p), liveOrderSubmission: 'disabled' });
});

/** POST: define the pilot allowlist (one investor, one MEXC account reference, one contract) and limits. */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const b = (await readJson(req)) as Record<string, unknown>;
  const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
  if (typeof b.maxLeverage !== 'number') throw new DomainError(400, ErrorCode.VALIDATION_FAILED, 'maxLeverage must be a number.');
  const p = await createPilot(
    getDb(),
    user.id,
    { investorId: s('investorId'), instrumentId: s('instrumentId'), exchangeAccountRef: s('exchangeAccountRef'), maxOrderContracts: s('maxOrderContracts'), maxOrderNotionalUsdt: s('maxOrderNotionalUsdt'), maxLeverage: b.maxLeverage, maxExposureUsdt: s('maxExposureUsdt') },
    correlationId
  );
  return json(correlationId, { pilot: p, readiness: pilotReadiness(p) }, 201);
});
