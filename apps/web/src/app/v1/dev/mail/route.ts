import { getDb, listCapturedEmails } from '@trendpilot/db';
import { notFound } from '@trendpilot/domain';
import { json, route } from '@/server/http';
import { devMailboxEnabled } from '@/server/devMailbox';

export const dynamic = 'force-dynamic';

/** Development email capture. 404 unless DEV_MAILBOX=enabled outside production. */
export const GET = route(async (_req, { correlationId }) => {
  if (!devMailboxEnabled()) throw notFound();
  return json(correlationId, { items: await listCapturedEmails(getDb()) });
});
