import { createSession, getDb, recordAudit, resolveMfaChallenge, revokeSession } from '@trendpilot/db';
import { DomainError, ErrorCode, mfaCodeSchema } from '@trendpilot/domain';
import { verifyUserCode } from '@/server/accounts';
import { json, parseBody, route } from '@/server/http';
import { clearLimit, hitLimit } from '@/server/rateLimit';
import { sessionCookie, sessionTokenFrom, sessionTtlHours } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Second sign-in step: exchanges an MFA_PENDING session plus a valid TOTP code for a full session. */
export const POST = route(async (req, { correlationId }) => {
  const { code } = await parseBody(req, mfaCodeSchema);
  const db = getDb();
  const token = sessionTokenFrom(req);
  const challenge = await resolveMfaChallenge(db, token);
  if (!challenge || !token) throw new DomainError(401, ErrorCode.UNAUTHENTICATED, 'Your sign-in expired. Enter your email and password again.');

  const limitKey = `mfa:${challenge.sessionId}`;
  if (hitLimit(limitKey)) {
    await revokeSession(db, token);
    throw new DomainError(429, ErrorCode.RATE_LIMITED, 'Too many attempts. Sign in again.');
  }

  if (!(await verifyUserCode(challenge.user, code))) {
    await recordAudit(db, { actorUserId: challenge.user.id, action: 'AUTH_MFA', targetType: 'user', targetId: challenge.user.id, result: 'FAILED', correlationId });
    throw new DomainError(400, ErrorCode.INVALID_MFA_CODE, 'That code is not valid. Check the time on your device and try again.');
  }

  // Rotate: the pending session is revoked and a fresh full session is issued.
  await revokeSession(db, token);
  clearLimit(limitKey);
  clearLimit(`login:${challenge.user.email}`);
  const ttl = sessionTtlHours();
  const fresh = await createSession(db, challenge.user.id, ttl, { userAgent: req.headers.get('user-agent') });
  await recordAudit(db, { actorUserId: challenge.user.id, action: 'AUTH_LOGIN', targetType: 'user', targetId: challenge.user.id, result: 'SUCCESS', metadata: { mfa: true }, correlationId });
  return json(correlationId, { user: { id: challenge.user.id, name: challenge.user.name, role: challenge.user.role } }, 200, {
    'set-cookie': sessionCookie(fresh.token, Math.round(ttl * 3600))
  });
});
