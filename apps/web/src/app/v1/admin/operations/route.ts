import { codeRevision, getDb, getOperationsStatus } from '@trendpilot/db';
import { now } from '@/server/clock';
import { json, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * UI-05 Operations: database, worker and feed liveness, job queue and failures, feed health, alerts.
 * `webRevision`: the code revision this web process runs (worker revisions are in the heartbeats).
 */
export const GET = route(async (req, { correlationId }) => {
  await requireAdmin(req);
  return json(correlationId, { ...(await getOperationsStatus(getDb(), now())), webRevision: codeRevision() });
});
