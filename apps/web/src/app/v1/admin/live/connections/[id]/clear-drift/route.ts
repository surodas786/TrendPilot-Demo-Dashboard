import { clearConnectionDrift, connectionDto, getDb } from '@trendpilot/db';
import { json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** POST { note }: clears a reviewed drift record once MEXC and TrendPilot match again. */
export const POST = route<{ id: string }>(async (req, { correlationId, params }) => {
  const { user } = await requireAdmin(req);
  const b = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
  return json(correlationId, { connection: connectionDto(await clearConnectionDrift(getDb(), user.id, params.id, String(b.note ?? ''), correlationId)) });
});
