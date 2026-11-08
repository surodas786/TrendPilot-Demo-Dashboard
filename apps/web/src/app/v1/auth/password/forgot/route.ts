import { forgotPasswordSchema } from '@trendpilot/domain';
import { requestPasswordReset } from '@/server/accounts';
import { json, parseBody, route } from '@/server/http';
import { hitLimit } from '@/server/rateLimit';

export const dynamic = 'force-dynamic';

/** IAM-01 password recovery. Always 202 with the same body, whether or not the email exists. */
export const POST = route(async (req, { correlationId }) => {
  const { email } = await parseBody(req, forgotPasswordSchema);
  if (!hitLimit(`forgot:${email.toLowerCase()}`)) await requestPasswordReset(email, correlationId);
  return json(correlationId, { message: 'If that email belongs to an active account, a reset link is on its way.' }, 202);
});
