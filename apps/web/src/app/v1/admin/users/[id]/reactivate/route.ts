import { reactivateInvestor } from '@/server/accounts';
import { etag, json, requireRevision, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  const u = await reactivateInvestor(user, params.id, requireRevision(req), correlationId);
  return json(correlationId, u, 200, { etag: etag(u.revision) });
});
