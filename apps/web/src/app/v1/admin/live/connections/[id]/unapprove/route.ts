import { connectionDto, getDb, unapproveConnection } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** POST: removes the account from the Live allowlist and switches its Live off. Closes keep working. */
export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  return json(correlationId, { connection: connectionDto(await unapproveConnection(getDb(), user.id, params.id, correlationId)) });
});
