import { connectionFor, getDb, lighterLiveRefusalFor, listPublishedInstruments, listPublishedVersions, orderBlocksFor } from '@trendpilot/db';
import { TradeSettingsClient } from '@/components/tradeSettings/TradeSettingsClient';
import { removalPreview } from '@/server/orderBlocks';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

export default async function TradeSettingsPage() {
  const { user } = await requirePageRole('INVESTOR');
  const db = getDb();
  // Owner comes from the session; the browser never names whose blocks to load.
  const [blocks, removal, instruments, versions, conn, bitunix, lighter] = await Promise.all([orderBlocksFor(db, user.id).list(), removalPreview(user), listPublishedInstruments(db), listPublishedVersions(db), connectionFor(db, user.id), connectionFor(db, user.id, 'BITUNIX'), connectionFor(db, user.id, 'LIGHTER')]);
  // Lighter markets this investor may trade Live (the Lighter Live scope; none by default).
  const lighterLiveIds: string[] = [];
  for (const i of instruments) if (i.exchange === 'LIGHTER' && !(await lighterLiveRefusalFor(db, { ownerId: user.id, instrumentId: i.id }, 'SEND'))) lighterLiveIds.push(i.id);
  return (
    <TradeSettingsClient
      ownerName={user.name}
      timezone={user.timezone}
      blocks={blocks}
      removal={removal}
      instruments={instruments}
      versions={versions}
      liveConnectionStatus={conn?.status ?? null}
      bitunixConnectionStatus={bitunix && bitunix.status !== 'REVOKED' ? bitunix.status : null}
      lighterConnectionStatus={lighter && lighter.status !== 'REVOKED' ? lighter.status : null}
      lighterLiveIds={lighterLiveIds}
    />
  );
}
