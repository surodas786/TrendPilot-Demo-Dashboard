import { connectionDto, getDb, haltConnectionEntries, schema } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import { eq } from 'drizzle-orm';
import { json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** POST { reason }: halts new Live entries on one account. Protection and closes keep running. */
export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  const db = getDb();
  const b = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
  const [c] = await db.select().from(schema.exchangeConnections).where(eq(schema.exchangeConnections.id, params.id));
  if (!c) throw new DomainError(404, ErrorCode.NOT_FOUND, 'Exchange connection not found.');
  await haltConnectionEntries(db, c.ownerId, `OPERATOR ${String(b.reason || 'halt').slice(0, 150)}`, user.id, correlationId);
  const [u] = await db.select().from(schema.exchangeConnections).where(eq(schema.exchangeConnections.id, params.id));
  return json(correlationId, { connection: connectionDto(u!) });
});
