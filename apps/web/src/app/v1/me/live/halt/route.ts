import { connectionDto, connectionFor, getDb, haltConnectionEntries } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import { json, readJson, route } from '@/server/http';
import { requireInvestor } from '@/server/session';

export const dynamic = 'force-dynamic';

/** POST: halts new Live entries on the investor's own account at once (an operator resumes). Closes continue. */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireInvestor(req);
  const db = getDb();
  const b = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
  const c = await connectionFor(db, user.id);
  if (!c || c.status === 'REVOKED') throw new DomainError(404, ErrorCode.NOT_FOUND, 'No exchange connection is set up.');
  await haltConnectionEntries(db, user.id, `INVESTOR ${String(b.reason || 'halt').slice(0, 150)}`, user.id, correlationId);
  return json(correlationId, { connection: connectionDto((await connectionFor(db, user.id))!) });
});
