import { acceptInviteSchema } from '@trendpilot/domain';
import { acceptInvite } from '@/server/accounts';
import { empty, parseBody, route } from '@/server/http';

export const dynamic = 'force-dynamic';

/** IAM-01: single-use invite link sets the first password and activates the investor. */
export const POST = route(async (req, { correlationId }) => {
  const { token, password } = await parseBody(req, acceptInviteSchema);
  await acceptInvite(token, password, correlationId);
  return empty(correlationId, 204);
});
