import { mfaCodeSchema } from '@trendpilot/domain';
import { confirmMfaSetup } from '@/server/accounts';
import { empty, parseBody, route } from '@/server/http';
import { requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireSession(req);
  const { code } = await parseBody(req, mfaCodeSchema);
  await confirmMfaSetup(user, code, correlationId);
  return empty(correlationId, 204);
});
