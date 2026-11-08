import { getDb, listAllInstruments } from '@trendpilot/db';
import { createPair } from '@/server/adminCatalog';
import { etag, json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

export const GET = route(async (req, { correlationId }) => {
  await requireAdmin(req);
  return json(correlationId, { items: await listAllInstruments(getDb()) });
});

/** Publish a pair validated against the local MEXC contract fixtures. */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const inst = await createPair(user, await readJson(req), correlationId);
  return json(correlationId, inst, 201, { etag: etag(inst.revision) });
});
