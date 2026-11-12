import { getDb, liveControlDto, setPlatformEntriesHalted } from '@trendpilot/db';
import { json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** POST { reason }: halts every new Live entry at once; protection and every close keep running. */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const b = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
  return json(correlationId, { control: liveControlDto(await setPlatformEntriesHalted(getDb(), user.id, true, String(b.reason ?? ''), correlationId)) });
});
