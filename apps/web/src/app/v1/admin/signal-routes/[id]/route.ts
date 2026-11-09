import { parseWith, signalRouteCreateSchema, signalRouteUpdateSchema } from '@trendpilot/domain';
import { empty, json, parseBody, readJson, requireRevision, route, validationError } from '@/server/http';
import { requireAdmin } from '@/server/session';
import { editSignalRoute, removeSignalRoute, setRouteEnabled } from '@/server/signalRoutes';

export const dynamic = 'force-dynamic';

/** Enable or disable a route (revision-checked). Re-enabling cannot create an ambiguous route; disabling cannot strand open positions. */
export const PATCH = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  const revision = requireRevision(req);
  const { enabled } = await parseBody(req, signalRouteUpdateSchema);
  return json(correlationId, await setRouteEnabled(user, params.id, revision, enabled, correlationId));
});

/** Edit every setting of a route (revision-checked, unique, strategy-compatible, no routing break). */
export const PUT = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  const revision = requireRevision(req);
  const r = parseWith(signalRouteCreateSchema, await readJson(req));
  if (!r.ok) throw validationError(r.issues);
  return json(correlationId, await editSignalRoute(user, params.id, revision, r.value, correlationId));
});

/** Permanent deletion of an unused route (no signal history, no open position depends on it). */
export const DELETE = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  const revision = requireRevision(req);
  await removeSignalRoute(user, params.id, revision, correlationId);
  return empty(correlationId);
});
