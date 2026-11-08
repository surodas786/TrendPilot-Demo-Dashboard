import { getDb, listIngress, recordAudit, rotateIngressToken, tokenHint } from '@trendpilot/db';
import { DomainError, ErrorCode } from '@trendpilot/domain';
import { json, route } from '@/server/http';
import { appBaseUrl } from '@/server/mail';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * SIG-01 rotation: issues a new high-entropy token, shown once in this response, and
 * invalidates the old one. The namespace (and so SIG-05 deduplication) is unchanged.
 */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const db = getDb();
  const [ingress] = await listIngress(db);
  if (!ingress) throw new DomainError(404, ErrorCode.NOT_FOUND, 'No webhook is configured.');
  const r = await rotateIngressToken(db, ingress.id);
  await recordAudit(db, { actorUserId: user.id, action: 'ADMIN_WEBHOOK_TOKEN_ROTATE', targetType: 'webhook_ingress', targetId: ingress.id, result: 'SUCCESS', metadata: { tokenHint: tokenHint(r!.ingress.tokenPrefix) }, correlationId });
  return json(correlationId, { url: `${appBaseUrl()}/v1/webhooks/tradingview/${r!.token}`, tokenHint: tokenHint(r!.ingress.tokenPrefix), notice: 'Copy this URL now. It is not shown again.' });
});
