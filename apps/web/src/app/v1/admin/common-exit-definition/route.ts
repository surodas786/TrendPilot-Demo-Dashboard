import { json, readJson, route } from '@/server/http';
import { commonExitView, publish } from '@/server/commonExit';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** GET /v1/admin/common-exit-definition — current rule, revision history, linked blocks and open positions. */
export const GET = route(async (req, { correlationId }) => {
  await requireAdmin(req);
  return json(correlationId, await commonExitView());
});

/**
 * POST /v1/admin/common-exit-definition — publish a new revision.
 * Body: { plan, scope: FUTURE_ENTRIES | EXISTING_POSITIONS, expectedVersion, note? }.
 */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const result = await publish(user.id, await readJson(req), correlationId);
  return json(correlationId, result, 201);
});
