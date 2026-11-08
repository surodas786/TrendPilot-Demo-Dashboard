import { ALLOWED_MODES } from '@trendpilot/domain';
import { json, route } from '@/server/http';
import { requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/** GET /v1/me — user, roles, allowed modes and timezone (§10.1). */
export const GET = route(async (req, { correlationId }) => {
  const { user } = await requireSession(req);
  return json(correlationId, {
    user: { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status, mfaEnabled: user.mfaEnabled },
    roles: [user.role],
    allowedModes: user.role === 'INVESTOR' ? [...ALLOWED_MODES] : [],
    timezone: user.timezone
  });
});
