import { getDb, recordAudit, sendMailTest } from '@trendpilot/db';
import { DomainError, ErrorCode, mailTestSchema } from '@trendpilot/domain';
import { json, parseBody, route } from '@/server/http';
import { hitLimit } from '@/server/rateLimit';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Test sends per admin per window (in-memory limiter, like sign-in). */
const MAIL_TEST_LIMIT = 5;
const MAIL_TEST_WINDOW_MS = 15 * 60_000;

/**
 * Sends one test email with the saved settings and reports whether the SMTP server accepted it.
 * A rejected or failed send is a normal 200 result with ok=false and a redacted reason.
 */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const { recipient } = await parseBody(req, mailTestSchema);
  if (hitLimit(`mail-test:${user.id}`, Date.now(), MAIL_TEST_LIMIT, MAIL_TEST_WINDOW_MS)) {
    await recordAudit(getDb(), { actorUserId: user.id, action: 'ADMIN_MAIL_TEST_SEND', targetType: 'mail_settings', result: 'DENIED', metadata: { recipient, outcome: 'RATE_LIMITED' }, correlationId });
    throw new DomainError(429, ErrorCode.RATE_LIMITED, `Too many test emails. You can send ${MAIL_TEST_LIMIT} every 15 minutes; try again later.`);
  }
  const result = await sendMailTest(getDb(), { adminId: user.id, recipient, correlationId });
  return json(correlationId, result);
});
