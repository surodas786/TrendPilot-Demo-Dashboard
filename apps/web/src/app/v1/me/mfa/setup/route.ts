import { beginMfaSetup } from '@/server/accounts';
import { json, route } from '@/server/http';
import { requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Starts TOTP enrolment for the signed-in user. The secret is returned once, to its owner. */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireSession(req);
  return json(correlationId, await beginMfaSetup(user, correlationId));
});
