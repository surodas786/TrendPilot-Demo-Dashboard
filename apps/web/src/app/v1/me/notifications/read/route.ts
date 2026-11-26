import { getDb, notificationsFor } from '@trendpilot/db';
import { json, readJson, route } from '@/server/http';
import { requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/** POST /v1/me/notifications/read — { ids } or { all: true }; only the user's own rows change. */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireSession(req);
  const body = ((await readJson(req)) ?? {}) as { ids?: unknown; all?: unknown };
  const ids = body.all === true ? 'ALL' : Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)) : [];
  return json(correlationId, { marked: await notificationsFor(getDb(), user.id).markRead(ids) });
});
