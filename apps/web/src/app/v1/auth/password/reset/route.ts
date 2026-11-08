import { resetPasswordSchema } from '@trendpilot/domain';
import { completePasswordReset } from '@/server/accounts';
import { empty, parseBody, route } from '@/server/http';

export const dynamic = 'force-dynamic';

/** IAM-01: single-use reset link sets a new password and revokes every session. */
export const POST = route(async (req, { correlationId }) => {
  const { token, password } = await parseBody(req, resetPasswordSchema);
  await completePasswordReset(token, password, correlationId);
  return empty(correlationId, 204);
});
