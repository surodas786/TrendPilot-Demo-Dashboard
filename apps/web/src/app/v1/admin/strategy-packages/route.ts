import { getDb, listPackages } from '@trendpilot/db';
import { createStrategyPackage } from '@/server/adminCatalog';
import { json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

export const GET = route(async (req, { correlationId }) => {
  await requireAdmin(req);
  return json(correlationId, { items: await listPackages(getDb()) });
});

export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  return json(correlationId, await createStrategyPackage(user, await readJson(req), correlationId), 201);
});
