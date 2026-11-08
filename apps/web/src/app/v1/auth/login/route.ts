import { createSession, findUserByEmail, getDb, normalizeEmail, recordAudit, revokeSession, verifyPassword } from '@trendpilot/db';
import { DomainError, ErrorCode, loginSchema, MFA_CHALLENGE_TTL_MINUTES } from '@trendpilot/domain';
import { json, parseBody, route } from '@/server/http';
import { clearLimit, hitLimit } from '@/server/rateLimit';
import { sessionCookie, sessionTokenFrom, sessionTtlHours } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * IAM-01 sign-in. With MFA on, a correct password yields only a short-lived MFA_PENDING
 * session that can do nothing except POST /v1/auth/mfa.
 */
export const POST = route(async (req, { correlationId }) => {
  const input = await parseBody(req, loginSchema);
  const email = normalizeEmail(input.email);

  const limitKey = `login:${email}`;
  if (hitLimit(limitKey)) throw new DomainError(429, ErrorCode.RATE_LIMITED, 'Too many sign-in attempts. Try again later.');

  const db = getDb();
  const user = await findUserByEmail(db, email);
  const ok = await verifyPassword(user, input.password);
  if (!ok || !user || user.status !== 'ACTIVE') {
    await recordAudit(db, {
      actorUserId: user?.id ?? null,
      action: 'AUTH_LOGIN',
      targetType: 'user',
      targetId: user?.id ?? null,
      result: 'FAILED',
      metadata: { email, reason: !ok ? 'BAD_CREDENTIALS' : `USER_${user?.status}` },
      correlationId
    });
    // Same answer for unknown, invited, suspended and wrong password.
    throw new DomainError(401, ErrorCode.INVALID_CREDENTIALS, 'Email or password is incorrect.');
  }

  const previous = sessionTokenFrom(req);
  if (previous) await revokeSession(db, previous);
  const userAgent = req.headers.get('user-agent');

  if (user.mfaEnabledAt) {
    const ttl = MFA_CHALLENGE_TTL_MINUTES / 60;
    const { token } = await createSession(db, user.id, ttl, { stage: 'MFA_PENDING', userAgent });
    await recordAudit(db, { actorUserId: user.id, action: 'AUTH_LOGIN_PASSWORD_OK', targetType: 'user', targetId: user.id, result: 'SUCCESS', metadata: { mfaRequired: true }, correlationId });
    return json(correlationId, { mfaRequired: true }, 200, { 'set-cookie': sessionCookie(token, MFA_CHALLENGE_TTL_MINUTES * 60) });
  }

  const ttl = sessionTtlHours();
  const { token } = await createSession(db, user.id, ttl, { userAgent });
  clearLimit(limitKey);
  await recordAudit(db, { actorUserId: user.id, action: 'AUTH_LOGIN', targetType: 'user', targetId: user.id, result: 'SUCCESS', correlationId });
  return json(correlationId, { mfaRequired: false, user: { id: user.id, name: user.name, role: user.role } }, 200, {
    'set-cookie': sessionCookie(token, Math.round(ttl * 3600))
  });
});
