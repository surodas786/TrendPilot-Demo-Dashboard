import { getDb, haltPilotEntries, pilotForInvestor } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import { json, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** The investor halts their own new entries at any time. Only an operator can resume. */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const db = getDb();
  const p = await pilotForInvestor(db, user.id);
  if (!p) throw new DomainError(404, ErrorCode.NOT_FOUND, 'No live pilot is offered to this account.');
  await haltPilotEntries(db, p.id, 'Investor halt', user.id, correlationId);
  return json(correlationId, { entriesHalted: true });
});
