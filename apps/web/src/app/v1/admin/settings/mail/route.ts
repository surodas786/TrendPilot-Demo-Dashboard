import { getDb, getMailBoxView, saveMailSettings } from '@trendpilot/db';
import { mailSettingsInputSchema } from '@trendpilot/domain';
import { etag, json, parseBody, requireRevision, route } from '@/server/http';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Admin → Settings → Mail Box. The SMTP password is never returned; only `passwordConfigured`. */
export const GET = route(async (req, { correlationId }) => {
  await requireAdmin(req);
  const view = await getMailBoxView(getDb());
  return json(correlationId, view, 200, { etag: etag(view.settings.revision) });
});

/** Saves the settings (If-Match: current revision, "0" for the first save). Blank password keeps the stored one. */
export const PUT = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const expectedRevision = requireRevision(req);
  const input = await parseBody(req, mailSettingsInputSchema);
  await getDb().transaction((tx) => saveMailSettings(tx, input, { adminId: user.id, expectedRevision, correlationId }));
  const view = await getMailBoxView(getDb());
  return json(correlationId, view, 200, { etag: etag(view.settings.revision) });
});
