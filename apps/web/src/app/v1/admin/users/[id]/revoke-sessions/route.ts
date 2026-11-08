import { adminRevokeSessions } from '@/server/accounts';
import { json, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  return json(correlationId, { revoked: await adminRevokeSessions(user, params.id, correlationId) });
});
