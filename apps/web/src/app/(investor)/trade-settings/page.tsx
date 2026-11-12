import { connectionFor, getDb, listPublishedInstruments, listPublishedVersions, orderBlocksFor } from '@trendpilot/db';
import { TradeSettingsClient } from '@/components/tradeSettings/TradeSettingsClient';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

export default async function TradeSettingsPage() {
  const { user } = await requirePageRole('INVESTOR');
  const db = getDb();
  // Owner comes from the session; the browser never names whose blocks to load.
  const [blocks, instruments, versions, conn] = await Promise.all([orderBlocksFor(db, user.id).list(), listPublishedInstruments(db), listPublishedVersions(db), connectionFor(db, user.id)]);
  return <TradeSettingsClient ownerName={user.name} timezone={user.timezone} blocks={blocks} instruments={instruments} versions={versions} liveConnectionStatus={conn?.status ?? null} />;
}
