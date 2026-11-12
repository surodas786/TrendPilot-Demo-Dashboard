import { connectionDto, getDb, resumeConnectionEntries } from '@trendpilot/db';
import { json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** POST { note }: resumes new Live entries on one account. Refused while orders are unresolved, a position is unprotected, or drift is open. */
export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  const b = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
  return json(correlationId, { connection: connectionDto(await resumeConnectionEntries(getDb(), user.id, params.id, String(b.note ?? ''), correlationId)) });
});
