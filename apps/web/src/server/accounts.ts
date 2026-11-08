import {
  consumeToken,
  createInvitedInvestor,
  disableMfa,
  enableMfa,
  findUserByEmail,
  findUserById,
  getDb,
  hashPassword,
  issueToken,
  peekToken,
  recordAudit,
  revokeAllSessions,
  secretBox,
  setPassword,
  setPendingMfaSecret,
  setUserStatus,
  supersedeTokens,
  toAdminUser,
  totp,
  acceptMfaStep,
  type AdminUserDto,
  type PublicUser,
  type UserRow
} from '@trendpilot/db';
import { DomainError, ErrorCode, INVITE_TTL_HOURS, notFound, RESET_TTL_MINUTES } from '@trendpilot/domain';
import { sendInviteEmail, sendNoticeEmail, sendResetEmail } from './mail';

/** IAM-01 account access use cases. Every state change is audited with actor and correlation ID. */

const linkInvalid = () => new DomainError(400, ErrorCode.LINK_INVALID, 'This link is invalid, expired or already used. Ask for a new one.');
const conflict = () => new DomainError(409, ErrorCode.REVISION_CONFLICT, 'This user changed since you loaded the page. Reload and try again.');

async function investorTarget(id: string): Promise<UserRow> {
  const u = await findUserById(getDb(), id);
  // Admins manage investors only; other admins are not reachable through these actions.
  if (!u || u.role !== 'INVESTOR') throw notFound();
  return u;
}

/* ───────────── Admin actions ───────────── */

export async function inviteInvestor(admin: PublicUser, input: { name: string; email: string }, correlationId: string): Promise<AdminUserDto> {
  return getDb().transaction(async (tx) => {
    const user = await createInvitedInvestor(tx, input, admin.id);
    const { token } = await issueToken(tx, user.id, 'INVITE', INVITE_TTL_HOURS * 3_600_000, admin.id);
    await sendInviteEmail(tx, user, token);
    await recordAudit(tx, { actorUserId: admin.id, action: 'ADMIN_USER_INVITE', targetType: 'user', targetId: user.id, result: 'SUCCESS', after: { email: user.email, name: user.name, role: user.role }, correlationId });
    return toAdminUser(user);
  });
}

export async function resendInvite(admin: PublicUser, userId: string, correlationId: string): Promise<void> {
  const user = await investorTarget(userId);
  if (user.status !== 'INVITED') throw new DomainError(409, ErrorCode.CONFLICT, 'This investor has already accepted the invitation.');
  await getDb().transaction(async (tx) => {
    const { token } = await issueToken(tx, user.id, 'INVITE', INVITE_TTL_HOURS * 3_600_000, admin.id);
    await sendInviteEmail(tx, user, token);
    await recordAudit(tx, { actorUserId: admin.id, action: 'ADMIN_USER_INVITE_RESEND', targetType: 'user', targetId: user.id, result: 'SUCCESS', correlationId });
  });
}

/** IAM-01: suspension blocks sign-in and new entries; all sessions and pending links are revoked. */
export async function suspendInvestor(admin: PublicUser, userId: string, revision: number, correlationId: string): Promise<AdminUserDto> {
  const user = await investorTarget(userId);
  if (user.status === 'SUSPENDED') return toAdminUser(user);
  return getDb().transaction(async (tx) => {
    const updated = await setUserStatus(tx, user.id, revision, 'SUSPENDED');
    if (!updated) throw conflict();
    const revoked = await revokeAllSessions(tx, user.id);
    await supersedeTokens(tx, user.id);
    await sendNoticeEmail(tx, user, 'SUSPENDED', 'An administrator suspended your access. Your sessions were ended. Existing protection on open positions is not affected.');
    await recordAudit(tx, {
      actorUserId: admin.id,
      action: 'ADMIN_USER_SUSPEND',
      targetType: 'user',
      targetId: user.id,
      result: 'SUCCESS',
      before: { status: user.status },
      after: { status: 'SUSPENDED' },
      metadata: { sessionsRevoked: revoked },
      correlationId
    });
    return toAdminUser(updated);
  });
}

export async function reactivateInvestor(admin: PublicUser, userId: string, revision: number, correlationId: string): Promise<AdminUserDto> {
  const user = await investorTarget(userId);
  if (user.status !== 'SUSPENDED') throw new DomainError(409, ErrorCode.CONFLICT, 'Only suspended investors can be reactivated.');
  return getDb().transaction(async (tx) => {
    const updated = await setUserStatus(tx, user.id, revision, 'ACTIVE');
    if (!updated) throw conflict();
    await recordAudit(tx, { actorUserId: admin.id, action: 'ADMIN_USER_REACTIVATE', targetType: 'user', targetId: user.id, result: 'SUCCESS', before: { status: 'SUSPENDED' }, after: { status: 'ACTIVE' }, correlationId });
    return toAdminUser(updated);
  });
}

/** IAM-01 authorized reset initiated by an admin. */
export async function adminSendReset(admin: PublicUser, userId: string, correlationId: string): Promise<void> {
  const user = await investorTarget(userId);
  if (user.status !== 'ACTIVE') throw new DomainError(409, ErrorCode.CONFLICT, 'Password resets are only sent to active investors.');
  await getDb().transaction(async (tx) => {
    const { token } = await issueToken(tx, user.id, 'RESET', RESET_TTL_MINUTES * 60_000, admin.id);
    await sendResetEmail(tx, user, token);
    await recordAudit(tx, { actorUserId: admin.id, action: 'ADMIN_USER_RESET_SEND', targetType: 'user', targetId: user.id, result: 'SUCCESS', correlationId });
  });
}

export async function adminRevokeSessions(admin: PublicUser, userId: string, correlationId: string): Promise<number> {
  const user = await investorTarget(userId);
  return getDb().transaction(async (tx) => {
    const n = await revokeAllSessions(tx, user.id);
    await recordAudit(tx, { actorUserId: admin.id, action: 'ADMIN_USER_SESSIONS_REVOKE', targetType: 'user', targetId: user.id, result: 'SUCCESS', metadata: { sessionsRevoked: n }, correlationId });
    return n;
  });
}

/* ───────────── Link flows (no session) ───────────── */

export async function checkLink(token: string, kind: 'INVITE' | 'RESET'): Promise<{ name: string; email: string }> {
  const t = await peekToken(getDb(), token, kind);
  const u = t && (await findUserById(getDb(), t.userId));
  if (!u || (kind === 'INVITE' ? u.status !== 'INVITED' : u.status !== 'ACTIVE')) throw linkInvalid();
  return { name: u.name, email: u.email };
}

export async function acceptInvite(token: string, password: string, correlationId: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await getDb().transaction(async (tx) => {
    const t = await consumeToken(tx, token, 'INVITE');
    const u = t && (await findUserById(tx, t.userId));
    if (!u || u.status !== 'INVITED') throw linkInvalid();
    await setPassword(tx, u.id, passwordHash, true);
    await recordAudit(tx, { actorUserId: u.id, action: 'ACCOUNT_INVITE_ACCEPT', targetType: 'user', targetId: u.id, result: 'SUCCESS', correlationId });
  });
}

/** Self-service recovery. Always answers the same way so it never reveals whether an email exists. */
export async function requestPasswordReset(email: string, correlationId: string): Promise<void> {
  const db = getDb();
  const u = await findUserByEmail(db, email);
  if (!u || u.status !== 'ACTIVE') {
    await recordAudit(db, { actorUserId: null, action: 'ACCOUNT_RESET_REQUEST', targetType: 'user', targetId: u?.id ?? null, result: 'DENIED', metadata: { reason: u ? 'NOT_ACTIVE' : 'UNKNOWN_EMAIL' }, correlationId });
    return;
  }
  await db.transaction(async (tx) => {
    const { token } = await issueToken(tx, u.id, 'RESET', RESET_TTL_MINUTES * 60_000, null);
    await sendResetEmail(tx, u, token);
    await recordAudit(tx, { actorUserId: u.id, action: 'ACCOUNT_RESET_REQUEST', targetType: 'user', targetId: u.id, result: 'SUCCESS', correlationId });
  });
}

/** Completing a reset revokes every session of the user (IAM-01 session revocation). */
export async function completePasswordReset(token: string, password: string, correlationId: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  await getDb().transaction(async (tx) => {
    const t = await consumeToken(tx, token, 'RESET');
    const u = t && (await findUserById(tx, t.userId));
    if (!u || u.status !== 'ACTIVE') throw linkInvalid();
    await setPassword(tx, u.id, passwordHash, false);
    const revoked = await revokeAllSessions(tx, u.id);
    await sendNoticeEmail(tx, u, 'PASSWORD_CHANGED', 'Your password was changed and all sessions were signed out. If this was not you, contact your administrator.');
    await recordAudit(tx, { actorUserId: u.id, action: 'ACCOUNT_PASSWORD_RESET', targetType: 'user', targetId: u.id, result: 'SUCCESS', metadata: { sessionsRevoked: revoked }, correlationId });
  });
}

/* ───────────── MFA (TOTP) ───────────── */

export async function beginMfaSetup(user: PublicUser, correlationId: string): Promise<{ secret: string; otpauthUri: string }> {
  if (user.mfaEnabled) throw new DomainError(409, ErrorCode.CONFLICT, 'Two-step sign-in is already on.');
  const secret = totp.newTotpSecret();
  const db = getDb();
  await setPendingMfaSecret(db, user.id, secretBox.seal(secret));
  await recordAudit(db, { actorUserId: user.id, action: 'ACCOUNT_MFA_SETUP_START', targetType: 'user', targetId: user.id, result: 'SUCCESS', correlationId });
  // The secret is shown once, to its owner, for enrolment. It is stored only sealed.
  return { secret, otpauthUri: totp.otpauthUri(secret, user.email) };
}

const badCode = () => new DomainError(400, ErrorCode.INVALID_MFA_CODE, 'That code is not valid. Check the time on your device and try again.');

export async function confirmMfaSetup(user: PublicUser, code: string, correlationId: string): Promise<void> {
  const db = getDb();
  const row = await findUserById(db, user.id);
  if (!row?.mfaPendingSecretEnc) throw new DomainError(409, ErrorCode.CONFLICT, 'Start two-step setup first.');
  const secret = secretBox.open(row.mfaPendingSecretEnc);
  const step = totp.verifyTotp(secret, code);
  if (step === null) {
    await recordAudit(db, { actorUserId: user.id, action: 'ACCOUNT_MFA_ENABLE', targetType: 'user', targetId: user.id, result: 'FAILED', correlationId });
    throw badCode();
  }
  await db.transaction(async (tx) => {
    await enableMfa(tx, user.id, row.mfaPendingSecretEnc!, step);
    await sendNoticeEmail(tx, row, 'MFA_ENABLED', 'Two-step sign-in is now required for your account.');
    await recordAudit(tx, { actorUserId: user.id, action: 'ACCOUNT_MFA_ENABLE', targetType: 'user', targetId: user.id, result: 'SUCCESS', correlationId });
  });
}

/** Verifies a TOTP code for a user with MFA on, enforcing single use of each time step. */
export async function verifyUserCode(row: UserRow, code: string): Promise<boolean> {
  if (!row.mfaSecretEnc) return false;
  const step = totp.verifyTotp(secretBox.open(row.mfaSecretEnc), code, Date.now(), row.mfaLastStep);
  return step !== null && (await acceptMfaStep(getDb(), row.id, step));
}

export async function turnOffMfa(user: PublicUser, code: string, correlationId: string): Promise<void> {
  const db = getDb();
  const row = await findUserById(db, user.id);
  if (!row?.mfaEnabledAt) throw new DomainError(409, ErrorCode.CONFLICT, 'Two-step sign-in is not on.');
  if (!(await verifyUserCode(row, code))) {
    await recordAudit(db, { actorUserId: user.id, action: 'ACCOUNT_MFA_DISABLE', targetType: 'user', targetId: user.id, result: 'FAILED', correlationId });
    throw badCode();
  }
  await disableMfa(db, user.id);
  await recordAudit(db, { actorUserId: user.id, action: 'ACCOUNT_MFA_DISABLE', targetType: 'user', targetId: user.id, result: 'SUCCESS', correlationId });
}
