/**
 * Read-only trace of Trade Settings → Add Token for one investor: why a pair or strategy is (or
 * is not) offered in Paper and in Live, using the same rules as the editor and the server.
 *
 *   npm run ops:trade-settings-check -- --email investor@…
 *
 * Database: one READ ONLY transaction (any write is refused by Postgres). No exchange is called.
 * Prints the investor, their exchange connections, published pairs with the mode each supports,
 * the latest published strategy versions approved per pair, their existing order blocks, the
 * mode the Add Token editor opens in, and per mode the pairs and strategies it would list.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { isPaperExchange, liveUnavailableReason } from '@trendpilot/domain';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { listPublishedInstruments, listPublishedVersions } from '../repos/catalog';
import { latestCommonExit } from '../repos/commonExit';
import { exchangeConnections, orderBlocks, users } from '../schema';

loadRootEnv();
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const email = arg('email');
if (!email) {
  console.error('Give --email of the investor.');
  process.exit(2);
}
const print = (title: string, rows: unknown[] | Record<string, unknown>) => {
  const list = Array.isArray(rows) ? rows : [rows];
  console.log(`\n## ${title} (${list.length})`);
  if (list.length) console.table(list);
};
const h = createDb(requireEnv('DATABASE_URL'), 1);

try {
  await h.db.transaction(
    async (tx) => {
      const [user] = await tx.select({ id: users.id, email: users.email, name: users.name, role: users.role, status: users.status }).from(users).where(eq(users.email, email.toLowerCase()));
      if (!user) {
        console.log(`No user with email ${email}.`);
        return;
      }
      print('Investor', user);
      const conns = await tx.select().from(exchangeConnections).where(eq(exchangeConnections.ownerId, user.id));
      print(
        'Exchange connections',
        conns.map((c) => ({ exchange: c.exchange, status: c.status, positionMode: (c as { positionMode?: string | null }).positionMode ?? null, liveEnabled: c.liveEnabled, approvedAt: c.approvedAt?.toISOString() ?? null }))
      );
      const statusOf = (x: string) => {
        const c = conns.find((k) => k.exchange === x);
        return c && c.status !== 'REVOKED' ? c.status : null;
      };
      // Sequential: one connection, one READ ONLY transaction.
      const instruments = await listPublishedInstruments(tx);
      const versions = await listPublishedVersions(tx);
      const blocks = await tx.select().from(orderBlocks).where(and(eq(orderBlocks.ownerId, user.id), isNull(orderBlocks.archivedAt)));
      const admin = await latestCommonExit(tx);
      const supports = (exchange: string, mode: 'PAPER' | 'LIVE') => (mode === 'LIVE' ? true : isPaperExchange(exchange));
      const approved = (id: string) => versions.filter((v) => v.isLatest && !v.packageArchived && v.instrumentIds.includes(id));
      print(
        'Published pairs',
        instruments.map((i) => ({
          pair: `${i.base}/${i.quote}`,
          exchange: i.exchange,
          symbol: i.exchangeSymbol,
          paper: supports(i.exchange, 'PAPER') ? 'yes' : 'no (Live only)',
          liveReady: liveUnavailableReason(statusOf(i.exchange), i.exchange) ?? 'yes',
          approvedStrategies: approved(i.id).map((v) => `${v.packageName} v${v.version}`).join(', ') || 'NONE'
        }))
      );
      print(
        'Existing order blocks',
        blocks.map((b) => ({ instrumentId: b.instrumentId, mode: b.mode, status: b.status, syncAdminExit: b.syncAdminExit }))
      );
      const taken = (mode: string) => blocks.filter((b) => b.mode === mode).map((b) => b.instrumentId);
      const free = (mode: 'PAPER' | 'LIVE') => instruments.filter((i) => supports(i.exchange, mode) && !taken(mode).includes(i.id));
      const liveConnected = ['MEXC', 'BITUNIX'].some((x) => statusOf(x) === 'VERIFIED') || statusOf('LIGHTER') === 'VERIFIED';
      const opens = free('PAPER').length === 0 && liveConnected && free('LIVE').length > 0 ? 'LIVE' : 'PAPER';
      console.log(`\n## Add Token opens in: ${opens}  (Live selectable: ${liveConnected ? 'yes' : 'no — no verified exchange connection'})`);
      for (const mode of ['PAPER', 'LIVE'] as const) {
        const list = free(mode);
        print(
          `${mode} pair list`,
          list.length
            ? list.map((i) => ({ pair: `${i.base}/${i.quote} · ${i.exchange} ${i.exchangeSymbol}`, strategies: approved(i.id).map((v) => `${v.packageName} v${v.version} (${v.permittedDirections})`).join(', ') || 'NONE — an admin must publish a version with this pair' }))
            : [{ pair: 'No pairs available', why: mode === 'PAPER' ? 'Every published pair is Live only or already has a Paper block' : liveConnected ? 'Every pair already has a Live block' : 'No verified exchange connection' }]
        );
      }
      console.log(`\n## Common Exit Definition: ${admin ? `version ${admin.version} published ${admin.publishedAt}` : 'none published (Sync Admin Setting cannot be turned on)'}`);
    },
    { accessMode: 'read only' }
  );
} finally {
  await h.close();
}
