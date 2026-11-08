import { adminSendReset } from '@/server/accounts';
import { empty, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** IAM-01 authorized reset: emails the investor a single-use reset link. */
export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  await adminSendReset(user, params.id, correlationId);
  return empty(correlationId, 204);
});
