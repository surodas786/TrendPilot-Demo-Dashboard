import { getDb, listUsers } from '@trendpilot/db';
import { inviteCreateSchema } from '@trendpilot/domain';
import { inviteInvestor } from '@/server/accounts';
import { json, parseBody, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Admin user directory. Never returns credentials or MFA secrets. */
export const GET = route(async (req, { correlationId }) => {
  await requireAdmin(req);
  return json(correlationId, { items: await listUsers(getDb()) });
});

/** IAM-01: create a named investor and send an invitation (captured locally in development). */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const input = await parseBody(req, inviteCreateSchema);
  return json(correlationId, await inviteInvestor(user, input, correlationId), 201);
});
