import { captureEmail, type Executor } from '@trendpilot/db';
import { INVITE_TTL_HOURS, RESET_TTL_MINUTES } from '@trendpilot/domain';

/**
 * Links are built from the configured APP_BASE_URL, never from request headers
 * (prevents host-header poisoning of reset links). Tokens travel in the URL fragment,
 * so they are never sent to the server in a GET request or written to access logs.
 */
export const appBaseUrl = () => (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

export async function sendInviteEmail(db: Executor, to: { email: string; name: string }, token: string): Promise<void> {
  const link = `${appBaseUrl()}/account/invite#token=${token}`;
  await captureEmail(db, {
    to: to.email,
    template: 'INVITE',
    subject: 'You are invited to TrendPilot',
    body: `Hello ${to.name},\n\nAn administrator created a TrendPilot investor account for you.\nSet your password here (single use, expires in ${INVITE_TTL_HOURS} hours):\n\n${link}\n\nIf you did not expect this, ignore this email.`
  });
}

export async function sendResetEmail(db: Executor, to: { email: string; name: string }, token: string): Promise<void> {
  const link = `${appBaseUrl()}/account/reset#token=${token}`;
  await captureEmail(db, {
    to: to.email,
    template: 'RESET',
    subject: 'Reset your TrendPilot password',
    body: `Hello ${to.name},\n\nUse this link to choose a new password (single use, expires in ${RESET_TTL_MINUTES} minutes):\n\n${link}\n\nAll your signed-in sessions end when the password changes. If you did not ask for this, ignore this email.`
  });
}

export async function sendNoticeEmail(db: Executor, to: { email: string; name: string }, template: 'SUSPENDED' | 'MFA_ENABLED' | 'PASSWORD_CHANGED', text: string): Promise<void> {
  const subjects = { SUSPENDED: 'Your TrendPilot access was suspended', MFA_ENABLED: 'Two-step sign-in is now on', PASSWORD_CHANGED: 'Your TrendPilot password changed' };
  await captureEmail(db, { to: to.email, template, subject: subjects[template], body: `Hello ${to.name},\n\n${text}` });
}
