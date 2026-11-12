import { getDb, liveControlDto, setPlatformLive } from '@trendpilot/db';
import { json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** POST { enabled, note }: the platform Live switch (default Off). Off stops new Live entries; closes continue. */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const b = (await readJson(req)) as Record<string, unknown>;
  return json(correlationId, { control: liveControlDto(await setPlatformLive(getDb(), user.id, b.enabled === true, String(b.note ?? ''), correlationId)) });
});
