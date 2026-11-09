import { createIngress, getDb, listIngress, recordAudit, rotateIngressToken, tokenHint } from '@trendpilot/db';
import { json, route } from '@/server/http';
import { appBaseUrl } from '@/server/mail';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * SIG-01 rotation: issues a new high-entropy token, shown once in this response, and
 * invalidates the old one. The namespace (and so SIG-05 deduplication) is unchanged.
 * On a fresh deployment with no webhook yet, this creates it and issues its first token.
 */
export const POST = route(async (req, { correlationId }) => {
  const { user } = await requireAdmin(req);
  const db = getDb();
  const [existing] = await listIngress(db);
  if (!existing) {
    const created = await db.transaction(async (tx) => {
      const c = await createIngress(tx, { namespace: 'tradingview-main', name: 'TradingView', createdBy: user.id });
      await recordAudit(tx, { actorUserId: user.id, action: 'ADMIN_WEBHOOK_CREATE', targetType: 'webhook_ingress', targetId: c.ingress.id, result: 'SUCCESS', metadata: { tokenHint: tokenHint(c.ingress.tokenPrefix) }, correlationId });
      return c;
    });
    return json(correlationId, { url: `${appBaseUrl()}/v1/webhooks/tradingview/${created.token}`, tokenHint: tokenHint(created.ingress.tokenPrefix), created: true, notice: 'Copy this URL now. It is not shown again.' });
  }
  const ingress = existing;
  const r = await rotateIngressToken(db, ingress.id);
  await recordAudit(db, { actorUserId: user.id, action: 'ADMIN_WEBHOOK_TOKEN_ROTATE', targetType: 'webhook_ingress', targetId: ingress.id, result: 'SUCCESS', metadata: { tokenHint: tokenHint(r!.ingress.tokenPrefix) }, correlationId });
  return json(correlationId, { url: `${appBaseUrl()}/v1/webhooks/tradingview/${r!.token}`, tokenHint: tokenHint(r!.ingress.tokenPrefix), notice: 'Copy this URL now. It is not shown again.' });
});
