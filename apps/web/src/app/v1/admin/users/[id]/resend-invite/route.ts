import { resendInvite } from '@/server/accounts';
import { empty, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  await resendInvite(user, params.id, correlationId);
  return empty(correlationId, 204);
});
