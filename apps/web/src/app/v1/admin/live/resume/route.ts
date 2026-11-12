import { getDb, liveControlDto, setPlatformEntriesHalted } from '@trendpilot/db';
import { json, readJson, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** POST { note }: resumes new Live entries after review. */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const b = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
  return json(correlationId, { control: liveControlDto(await setPlatformEntriesHalted(getDb(), user.id, false, String(b.note ?? ''), correlationId)) });
});
