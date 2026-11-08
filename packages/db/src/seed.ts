import { eq, sql } from 'drizzle-orm';
import type { Db, Executor } from './client';
import { FIXTURE_IDS, FIXTURE_INSTRUMENTS, FIXTURE_SIGNAL_SOURCE, FIXTURE_STRATEGY, FIXTURE_USERS, TEST_ONLY_INSTRUMENTS, type FixtureInstrument } from './fixtures';
import { leverageChoicesFor, lookupFixtureContract } from './mexcFixtures';
import { hashPassword } from './repos/users';
import { instruments, signalRoutes, strategyPackages, strategyVersionInstruments, strategyVersions, users, webhookIngress } from './schema';
import { createIngress } from './signals/ingress';
import { lockPaperAccount } from './paper/accounts';

/** Password for fixture users. Dev/test only; seeding refuses production. */
export function seedPassword(): string {
  const p = process.env.SEED_PASSWORD;
  if (!p) throw new Error('SEED_PASSWORD is not set. Copy .env.example to .env.');
  return p;
}

function assertNotProduction(): void {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed fixture users with NODE_ENV=production.');
}

async function insertInstruments(db: Executor, list: FixtureInstrument[]): Promise<void> {
  for (const i of list) {
    const spec = lookupFixtureContract(i.symbol);
    if (!spec) throw new Error(`No MEXC contract fixture for ${i.symbol}`);
    await db
      .insert(instruments)
      .values({
        id: FIXTURE_IDS.instruments[i.symbol],
        exchange: 'MEXC',
        symbol: spec.symbol,
        exchangeSymbol: spec.exchangeSymbol,
        base: spec.base,
        quote: spec.quote,
        status: i.status,
        contractMultiplier: spec.contractMultiplier,
        qtyStep: spec.qtyStep,
        minQty: spec.minQty,
        maxQty: spec.maxQty,
        priceTick: spec.priceTick,
        takerFeeRate: spec.takerFeeRate,
        leverageChoices: leverageChoicesFor(spec.maxLeverage),
        suggestedStopPct: i.stop,
        suggestedTakeProfitPct: i.tp,
        suggestedTrailingEnabled: i.trailingEnabled,
        suggestedTrailingPct: i.trailing,
        isFixture: true
      })
      .onConflictDoNothing();
  }
}

/**
 * Development seed. Idempotent: inserts missing fixture rows and leaves existing rows untouched.
 * One admin, two investors, one approved MEXC Futures contract, one published strategy version.
 */
export async function seedFixtures(db: Db): Promise<{ ingressToken: string | null }> {
  assertNotProduction();
  const passwordHash = await hashPassword(seedPassword());

  await db.transaction(async (tx) => {
    for (const u of Object.values(FIXTURE_USERS)) {
      await tx.insert(users).values({ ...u, passwordHash, status: 'ACTIVE' }).onConflictDoNothing({ target: users.email });
    }
    await insertInstruments(tx, FIXTURE_INSTRUMENTS);
    await tx.insert(strategyPackages).values({ id: FIXTURE_IDS.package, name: FIXTURE_STRATEGY.packageName }).onConflictDoNothing();
    // SCP-03: each seeded investor gets an isolated paper account with a fixture balance.
    for (const u of [FIXTURE_USERS.investorA, FIXTURE_USERS.investorB]) {
      const [row] = await tx.select({ id: users.id }).from(users).where(eq(users.email, u.email));
      if (row) await lockPaperAccount(tx, row.id);
    }

    const [existing] = await tx.select({ id: strategyVersions.id }).from(strategyVersions).where(eq(strategyVersions.id, FIXTURE_IDS.version));
    if (!existing) {
      // Draft → map approved pair → publish. Published versions are immutable (DB trigger).
      const { packageName: _name, ...v } = FIXTURE_STRATEGY;
      await tx.insert(strategyVersions).values({ id: FIXTURE_IDS.version, packageId: FIXTURE_IDS.package, ...v });
      await tx.insert(strategyVersionInstruments).values({ versionId: FIXTURE_IDS.version, instrumentId: FIXTURE_IDS.instruments.BTCUSDT });
      await tx.update(strategyVersions).set({ publishedAt: new Date('2026-11-01T00:00:00Z') }).where(eq(strategyVersions.id, FIXTURE_IDS.version));
    }
  });
  return seedSignalFixtures(db);
}

/**
 * Development TradingView ingress and the two approved BTCUSDT 15m routes (bullish/bearish).
 * The token comes from DEV_INGRESS_TOKEN (dev/test only); without it a random one is generated
 * and returned once. Only its hash is stored.
 */
export async function seedSignalFixtures(db: Db): Promise<{ ingressToken: string | null }> {
  assertNotProduction();
  const f = FIXTURE_SIGNAL_SOURCE;
  let [ingress] = await db.select().from(webhookIngress).where(eq(webhookIngress.namespace, f.ingressNamespace));
  let issued: string | null = null;
  if (!ingress) {
    const created = await createIngress(db, { namespace: f.ingressNamespace, name: f.ingressName, token: process.env.DEV_INGRESS_TOKEN || undefined });
    ingress = created.ingress;
    issued = created.token;
  }
  for (const action of ['BULLISH_FLIP', 'BEARISH_FLIP', 'CLOSE_LONG', 'CLOSE_SHORT'] as const) {
    await db
      .insert(signalRoutes)
      .values({
        ingressId: ingress.id,
        name: `BTCUSDT 15m ${{ BULLISH_FLIP: 'bullish flip', BEARISH_FLIP: 'bearish flip', CLOSE_LONG: 'close long', CLOSE_SHORT: 'close short' }[action]}`,
        sourceExchange: f.sourceExchange,
        sourceSymbol: f.sourceSymbol,
        interval: f.interval,
        action,
        kind: 'ACTIONABLE',
        instrumentId: FIXTURE_IDS.instruments.BTCUSDT,
        packageId: FIXTURE_IDS.package,
        maxSignalAgeSeconds: f.maxSignalAgeSeconds,
        clockToleranceSeconds: f.clockToleranceSeconds
      })
      .onConflictDoNothing();
  }
  return { ingressToken: issued };
}

/**
 * Test-only: adds the extra contracts automated tests need, plus a published test version
 * approved for BTCUSDT and ETHUSDT (the development version is approved for BTCUSDT only).
 */
export async function seedTestInstruments(db: Db): Promise<void> {
  assertNotProduction();
  await db.transaction(async (tx) => {
    await insertInstruments(tx, TEST_ONLY_INSTRUMENTS);
    await tx.insert(strategyPackages).values({ id: FIXTURE_IDS.testPackage, name: 'Test package — BTC and ETH' }).onConflictDoNothing();
    const [existing] = await tx.select({ id: strategyVersions.id }).from(strategyVersions).where(eq(strategyVersions.id, FIXTURE_IDS.testVersion));
    if (!existing) {
      const { packageName: _name, ...v } = FIXTURE_STRATEGY;
      await tx.insert(strategyVersions).values({ id: FIXTURE_IDS.testVersion, packageId: FIXTURE_IDS.testPackage, ...v });
      await tx.insert(strategyVersionInstruments).values([
        { versionId: FIXTURE_IDS.testVersion, instrumentId: FIXTURE_IDS.instruments.BTCUSDT },
        { versionId: FIXTURE_IDS.testVersion, instrumentId: FIXTURE_IDS.instruments.ETHUSDT }
      ]);
      await tx.update(strategyVersions).set({ publishedAt: new Date('2026-11-01T00:00:00Z') }).where(eq(strategyVersions.id, FIXTURE_IDS.testVersion));
    }
  });
}

/** Test-only: wipes every table. Refuses databases not named *_test or *_e2e. */
export async function resetDatabase(db: Db, connectionString: string): Promise<void> {
  assertNotProduction();
  const name = new URL(connectionString).pathname.slice(1);
  if (!/_(test|e2e)$/.test(name)) throw new Error(`Refusing to reset database "${name}": only *_test or *_e2e databases can be reset.`);
  await db.execute(
    sql`TRUNCATE position_targets, position_exits, sim_positions, ledger_entries, fills, positions, sim_fills, sim_orders, order_intents, paper_accounts, market_quotes, market_candles, signal_decisions, jobs, signal_rejections, signal_events, signal_routes, webhook_ingress, audit_events, email_outbox, user_tokens, order_blocks, sessions, strategy_version_instruments, strategy_versions, strategy_packages, instruments, users RESTART IDENTITY CASCADE`
  );
}
