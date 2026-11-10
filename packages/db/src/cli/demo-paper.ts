/**
 * Prepares the paper-entry demo for the local replay (development only).
 *
 *   npm run demo:paper -- [--at <UTC ISO>] [--ema off|on] [--market up|down|flat|gap|none] [--reset-paper] [--profile entries|exits|split|reverse]
 *
 * --profile exits:   both investors trade every day; A has a 3 % fixed TP, B a 6 % fixed TP.
 * --profile split:   A: split TP 50 % at +2 % and 30 % at +4 %, the 20 % remainder on Trailing
 *                    Take Profit (activates at +3 %, 1 % trail, mark). B: no TP, Trailing Take
 *                    Profit on 100 % (activates at +1 %, 1 % trail, last price).
 * --profile reverse: both pinned to a CLOSE_AND_REVERSE version of the package (created and
 *                    published if missing). B may only trade Long, so B's reversal stays flat.
 *
 * - Investor A: BTC/USDT Paper block, ACTIVE, all seven days, 100 USDT × 10, stop 1.5 %.
 * - Investor B: BTC/USDT Paper block, ACTIVE, every day EXCEPT the local (Asia/Dhaka) weekday
 *   at --at, so the shared alert records DAY_DISABLED for B.
 * - Both pinned to the fixture strategy version (EMA Off), or with --ema on to an EMA 200 version
 *   of the same package (created and published if missing).
 * - Writes fixture candles + quote for the signal bar (default market "up").
 * - --reset-paper truncates ALL paper trading state in this database (dev only).
 */
import { and, eq, sql } from 'drizzle-orm';
import { ALL_WEEKDAYS, lastClosedBarOpen, localWeekday, orderBlockSettingsSchema, WEEKDAY_LABELS, type OrderBlockSettingsInput } from '@trendpilot/domain';
import { createDb, type Db } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { FIXTURE_IDS, FIXTURE_STRATEGY, FIXTURE_USERS } from '../fixtures';
import { lockPaperAccount } from '../paper/accounts';
import { writeMarketFixture } from '../paper/market';
import { orderBlocks, strategyVersionInstruments, strategyVersions, users } from '../schema';

loadRootEnv();
if (process.env.NODE_ENV === 'production') throw new Error('The paper demo is for development only.');

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const at = new Date(arg('at') ?? process.env.SIGNAL_TEST_CLOCK ?? new Date().toISOString());
const ema = (arg('ema') ?? 'off') === 'on';
const market = arg('market') ?? 'up';
const profile = arg('profile') ?? 'entries';
if (!['entries', 'exits', 'split', 'reverse'].includes(profile)) throw new Error(`Unknown --profile ${profile}`);
const exitsProfile = profile !== 'entries';
const TZ = 'Asia/Dhaka';

async function versionWith(db: Db, o: { emaFilter: 'OFF' | 'EMA200'; oppositePolicy: 'KEEP_OPEN' | 'CLOSE_ONLY' | 'CLOSE_AND_REVERSE' }): Promise<string> {
  const rows = await db
    .select()
    .from(strategyVersions)
    .where(and(eq(strategyVersions.packageId, FIXTURE_IDS.package), eq(strategyVersions.emaFilter, o.emaFilter), eq(strategyVersions.oppositePolicy, o.oppositePolicy)));
  const published = rows.find((r) => r.publishedAt);
  if (published) return published.id;
  const [max] = await db.select({ v: sql<number>`max(${strategyVersions.version})` }).from(strategyVersions).where(eq(strategyVersions.packageId, FIXTURE_IDS.package));
  const { packageName: _n, ...v } = FIXTURE_STRATEGY;
  const [created] = await db
    .insert(strategyVersions)
    .values({ packageId: FIXTURE_IDS.package, ...v, version: Number(max!.v) + 1, emaFilter: o.emaFilter, oppositePolicy: o.oppositePolicy })
    .returning({ id: strategyVersions.id });
  await db.insert(strategyVersionInstruments).values({ versionId: created!.id, instrumentId: FIXTURE_IDS.instruments.BTCUSDT });
  await db.update(strategyVersions).set({ publishedAt: new Date() }).where(eq(strategyVersions.id, created!.id));
  return created!.id;
}

async function upsertBlock(db: Db, ownerId: string, settings: OrderBlockSettingsInput) {
  const s = orderBlockSettingsSchema.parse(settings);
  const values = { ...s, status: 'ACTIVE' as const, timezone: TZ };
  const [existing] = await db
    .select({ id: orderBlocks.id })
    .from(orderBlocks)
    .where(and(eq(orderBlocks.ownerId, ownerId), eq(orderBlocks.instrumentId, FIXTURE_IDS.instruments.BTCUSDT), eq(orderBlocks.mode, 'PAPER')));
  if (existing) {
    await db.update(orderBlocks).set({ ...values, revision: sql`${orderBlocks.revision} + 1`, updatedAt: sql`now()` }).where(eq(orderBlocks.id, existing.id));
  } else {
    await db.insert(orderBlocks).values({ ...values, ownerId, instrumentId: FIXTURE_IDS.instruments.BTCUSDT, mode: 'PAPER' });
  }
}

const h = createDb(process.env.DEMO_DATABASE_URL ?? requireEnv('DATABASE_URL'), 1);
try {
  const db = h.db;
  if (process.argv.includes('--reset-paper')) {
    await db.execute(sql`TRUNCATE paper_funding, funding_rates, position_targets, position_exits, sim_positions, ledger_entries, fills, positions, sim_fills, sim_orders, order_intents, paper_accounts RESTART IDENTITY CASCADE`);
    console.log('Reset all paper trading state in this database.');
  }
  const ids: Record<string, string> = {};
  for (const [k, u] of Object.entries({ A: FIXTURE_USERS.investorA, B: FIXTURE_USERS.investorB })) {
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, u.email));
    if (!row) throw new Error(`Run npm run db:seed first (missing ${u.email}).`);
    ids[k] = row.id;
  }
  const policy = profile === 'reverse' ? 'CLOSE_AND_REVERSE' : 'KEEP_OPEN';
  const versionId = !ema && policy === 'KEEP_OPEN' ? FIXTURE_IDS.version : await versionWith(db, { emaFilter: ema ? 'EMA200' : 'OFF', oppositePolicy: policy });
  const today = localWeekday(at, TZ);
  const common = {
    strategyVersionId: versionId,
    direction: 'BOTH' as const,
    marginMode: 'ISOLATED' as const,
    takeProfit: { mode: 'FIXED' as const, levels: [{ id: 'tp1', movePct: '3', closePct: '100' }] },
    trailing: { enabled: false, activationPct: null, distancePct: null, basis: 'MARK' as const },
    allowAdds: false,
    maxAdds: null,
    risk: { maxOpenPositions: null, maxNotionalUsdt: null, maxStopRiskUsdt: null, dailyLossLimitUsdt: null, cooldownMinutes: null, maxSpreadPct: null, maxPriceDeviationPct: null }
  };
  const tp = (movePct: string) => ({ mode: 'FIXED' as const, levels: [{ id: 'tp1', movePct, closePct: '100' }] });
  const off = { enabled: false, activationPct: null, distancePct: null, basis: 'MARK' as const };
  const plans = {
    A:
      profile === 'split'
        ? {
            takeProfit: { mode: 'SPLIT' as const, levels: [{ id: 'tp1', movePct: '2', closePct: '50' }, { id: 'tp2', movePct: '4', closePct: '30' }] },
            trailing: { enabled: true, activationPct: '3', distancePct: '1', basis: 'MARK' as const }
          }
        : { takeProfit: tp('3'), trailing: off },
    B:
      profile === 'split'
        ? { takeProfit: { mode: 'OFF' as const, levels: [] }, trailing: { enabled: true, activationPct: '1', distancePct: '1', basis: 'LAST' as const } }
        : { takeProfit: tp(exitsProfile ? '6' : '3'), trailing: off }
  };
  await upsertBlock(db, ids.A!, { ...common, ...plans.A, orderCostUsdt: '100', leverage: 10, stop: { type: 'PERCENT', value: '1.5', basis: 'MARK' }, weekdays: [...ALL_WEEKDAYS] });
  await upsertBlock(db, ids.B!, {
    ...common,
    ...plans.B,
    direction: profile === 'reverse' ? 'LONG_ONLY' : 'BOTH',
    orderCostUsdt: '50',
    leverage: 5,
    stop: { type: 'PERCENT', value: '2', basis: 'MARK' },
    weekdays: exitsProfile ? [...ALL_WEEKDAYS] : ALL_WEEKDAYS.filter((d) => d !== today)
  });
  await db.transaction(async (tx) => {
    await lockPaperAccount(tx, ids.A!);
    await lockPaperAccount(tx, ids.B!);
  });

  const bar = lastClosedBarOpen(at, '15');
  if (market !== 'none') {
    await writeMarketFixture(db, {
      instrumentId: FIXTURE_IDS.instruments.BTCUSDT,
      interval: '15',
      endBarOpen: bar,
      count: 260,
      endClose: '65000',
      trend: market === 'down' ? 'DOWN' : market === 'flat' ? 'FLAT' : 'UP',
      omit: market === 'gap' ? [new Date(bar.getTime() - 50 * 15 * 60_000)] : [],
      quoteAt: at
    });
  }

  console.log(`Paper demo ready at ${at.toISOString()} (${WEEKDAY_LABELS[today]} in ${TZ}).`);
  const versionLabel = `${ema ? 'EMA 200' : 'EMA Off'}, ${policy}`;
  const aPlan = profile === 'split' ? 'split TP 50% @ +2% and 30% @ +4%, trailing take profit on 20%: trail 1% after +3% (mark)' : 'TP 3%';
  console.log(`  Investor A: BTC/USDT Paper, ACTIVE, every day, 100 USDT x10, stop 1.5%, ${aPlan} (${versionLabel}).`);
  console.log(
    profile === 'split'
      ? '  Investor B: BTC/USDT Paper, ACTIVE, every day, 50 USDT x5, stop 2%, no TP, trailing take profit on 100%: trail 1% after +1% (last).'
      : profile === 'reverse'
        ? '  Investor B: BTC/USDT Paper, ACTIVE, every day, 50 USDT x5, stop 2%, TP 6%, Long only -> its reversal stays flat (DIRECTION_DISABLED).'
        : exitsProfile
          ? '  Investor B: BTC/USDT Paper, ACTIVE, every day, 50 USDT x5, stop 2%, TP 6% (A has TP 3%).'
          : `  Investor B: BTC/USDT Paper, ACTIVE, every day except ${WEEKDAY_LABELS[today]} -> expect DAY_DISABLED.`
  );
  console.log(`  FIXTURE market (${market}): candles to bar ${bar.toISOString()}, quote 65000 +/- 0.5 as of ${at.toISOString()}.`);
  console.log('Next: npm run replay   then   npm run worker:once   (same SIGNAL_TEST_CLOCK).');
} finally {
  await h.close();
}
