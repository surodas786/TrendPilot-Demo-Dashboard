// A TradingView alert from a Bitunix chart (BITUNIX:XAUUSDT.P) routed to the Bitunix gold perpetual
// as its own signal contract: the signal contract must be the chart's contract (same exchange and
// ticker), a mismatched contract is rejected on save, a missing one is explained, the 5m bullish and
// bearish routes save and reload with Bitunix XAUUSDT, an alert dispatches only to Bitunix, and the
// read-only readiness CLI (no orders) resolves execution only to Bitunix. Existing MEXC routes are
// left untouched.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_IDS, schema } from '@trendpilot/db';
import { buildTradingViewPayload, contractMatchesSource, PAPER_TEMPLATE, signalContractIssue } from '@trendpilot/domain';
import * as routes from '@/app/v1/admin/signal-routes/route';
import * as routeById from '@/app/v1/admin/signal-routes/[id]/route';
import * as bitunixTarget from '@/app/v1/admin/signal-routes/[id]/bitunix-target/route';
import * as versions from '@/app/v1/admin/strategy-packages/[id]/versions/route';
import * as publish from '@/app/v1/admin/strategy-versions/[id]/publish/route';
import * as webhook from '@/app/v1/webhooks/tradingview/[ingressToken]/route';
import { setTestClock } from '@/server/clock';
import { BTC, call, direct, resetAndSeed, signIn, teardown, USERS } from '../helpers';
import { testDatabaseUrl } from '../testDb';

const PKG = FIXTURE_IDS.package;
let admin: string;
let bxXau: string;
const created: Record<string, string> = {};

const body = (patch: Record<string, unknown> = {}) => ({
  name: 'Gold 5m Bitunix Bullish',
  sourceExchange: 'Bitunix', // as typed in the form; stored as BITUNIX ({{exchange}} of a Bitunix chart)
  sourceSymbol: 'XAUUSDT.P',
  interval: '5',
  action: 'BULLISH_FLIP',
  kind: 'ACTIONABLE',
  instrumentId: bxXau,
  packageId: PKG,
  maxSignalAgeSeconds: 120,
  clockToleranceSeconds: 5,
  ...patch
});

beforeAll(async () => {
  await resetAndSeed();
  setTestClock(() => new Date('2026-11-18T10:05:03Z'));
  admin = await signIn(USERS.admin.email);
  // The published Bitunix gold perpetual, as in production (Bitunix XAUUSDT, XAU/USDT).
  const [btc] = await direct.db.select().from(schema.instruments).where(eq(schema.instruments.id, BTC));
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = btc!;
  const [xau] = await direct.db
    .insert(schema.instruments)
    .values({ ...rest, exchange: 'BITUNIX', symbol: 'XAUUSDT', exchangeSymbol: 'XAUUSDT', base: 'XAU', quote: 'USDT', status: 'PUBLISHED', exchangeMarketId: null })
    .returning();
  bxXau = xau!.id;
  // The lineage's newest version is 5m and approves Bitunix XAUUSDT (production: v11, BITUNIX:XAUUSDT).
  const d = await call(versions.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: PKG }, body: { ...PAPER_TEMPLATE, timeframe: '5m', instrumentIds: [BTC, bxXau] } });
  expect(d.status).toBe(201);
  expect((await call(publish.POST, { method: 'POST', path: '/x', cookie: admin, params: { id: d.body.id }, ifMatch: d.body.revision })).status).toBe(200);
});

afterAll(async () => {
  setTestClock(null);
  await teardown();
});

describe('signal contract choices follow the source exchange and ticker', () => {
  it('BITUNIX:XAUUSDT.P matches only Bitunix XAUUSDT, never MEXC contracts', async () => {
    const all = await direct.db.select().from(schema.instruments);
    const matching = all.filter((i) => contractMatchesSource(i, 'Bitunix', 'XAUUSDT.P'));
    expect(matching.map((i) => `${i.exchange}:${i.exchangeSymbol}`)).toEqual(['BITUNIX:XAUUSDT']);
    expect(all.filter((i) => contractMatchesSource(i, 'MEXC', 'BTCUSDT.P')).map((i) => i.exchangeSymbol)).toEqual(['BTC_USDT']);
    expect(signalContractIssue(null, all, 'BITUNIX', 'XAUUSDT.P')).toMatch(/Select the signal contract for BITUNIX:XAUUSDT\.P: Bitunix XAUUSDT/);
  });
});

describe('saving a route', () => {
  it('rejects a mismatched contract (MEXC BTC_USDT for BITUNIX:XAUUSDT.P) with a specific error', async () => {
    const r = await call(routes.POST, { method: 'POST', path: '/x', cookie: admin, body: body({ instrumentId: BTC }) });
    expect(r.status).toBe(400);
    expect(r.body.issues).toEqual([{ path: 'instrumentId', message: 'MEXC BTC_USDT is not the contract of the BITUNIX:XAUUSDT.P chart. Select Bitunix XAUUSDT.' }]);
  });

  it('explains a missing contract instead of accepting another one', async () => {
    const r = await call(routes.POST, { method: 'POST', path: '/x', cookie: admin, body: body({ sourceSymbol: 'XAGUSDT.P', instrumentId: bxXau }) });
    expect(r.status).toBe(400);
    expect(r.body.issues[0]).toEqual({ path: 'instrumentId', message: expect.stringMatching(/^No Bitunix contract XAGUSDT exists for BITUNIX:XAGUSDT\.P\. Import and publish the Bitunix XAGUSDT perpetual in Admin → Trading Pairs/) });
  });

  it('5m Bullish and Bearish routes save and reload with the Bitunix signal contract', async () => {
    for (const action of ['BULLISH_FLIP', 'BEARISH_FLIP'] as const) {
      const r = await call(routes.POST, { method: 'POST', path: '/x', cookie: admin, body: body({ action, name: `Gold 5m Bitunix ${action === 'BULLISH_FLIP' ? 'Bullish' : 'Bearish'}` }) });
      expect(r.status).toBe(201);
      created[action] = r.body.id;
    }
    const list = await call(routes.GET, { path: '/x', cookie: admin });
    for (const id of Object.values(created)) {
      const r = list.body.items.find((x: { id: string }) => x.id === id);
      expect(r).toMatchObject({ sourceExchange: 'BITUNIX', sourceSymbol: 'XAUUSDT.P', interval: '5', instrument: { id: bxXau, exchange: 'BITUNIX', exchangeSymbol: 'XAUUSDT' } });
      expect(r.targets).toEqual([]);
    }
    // An edit (rename) keeps the contract; switching it to a MEXC contract is refused.
    const row = (await direct.db.select().from(schema.signalRoutes).where(eq(schema.signalRoutes.id, created.BEARISH_FLIP!)))[0]!;
    const ok = await call(routeById.PUT, { method: 'PUT', path: '/x', cookie: admin, params: { id: row.id }, ifMatch: row.revision, body: body({ action: 'BEARISH_FLIP', name: 'Gold 5m Bitunix Bearish (edited)' }) });
    expect(ok.status).toBe(200);
    const bad = await call(routeById.PUT, { method: 'PUT', path: '/x', cookie: admin, params: { id: row.id }, ifMatch: ok.body.revision, body: body({ action: 'BEARISH_FLIP', instrumentId: BTC }) });
    expect(bad.status).toBe(400);
    expect((await direct.db.select().from(schema.signalRoutes).where(eq(schema.signalRoutes.id, row.id)))[0]).toMatchObject({ instrumentId: bxXau, name: 'Gold 5m Bitunix Bearish (edited)' });
  });

  it('a Bitunix-chart route takes no extra Bitunix target (it already executes on Bitunix)', async () => {
    const r = await call(bitunixTarget.PUT, { method: 'PUT', path: '/x', cookie: admin, params: { id: created.BULLISH_FLIP! }, body: { instrumentId: bxXau, enabled: true } });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/already Bitunix XAUUSDT/);
  });

  it('existing MEXC routes are preserved', async () => {
    const [fixture] = await direct.db.select().from(schema.signalRoutes).where(eq(schema.signalRoutes.sourceSymbol, 'BTCUSDT.P'));
    expect(fixture).toMatchObject({ sourceExchange: 'MEXC', instrumentId: BTC, enabled: true, revision: 1 });
  });
});

describe('execution resolves only to Bitunix (no orders)', () => {
  it('a BITUNIX:XAUUSDT.P 5m alert is accepted on the Bitunix route and targets nothing else', async () => {
    const token = process.env.DEV_INGRESS_TOKEN!;
    const raw = JSON.stringify(
      buildTradingViewPayload({ action: 'BULLISH_FLIP', exchange: 'BITUNIX', symbol: 'XAUUSDT.P', interval: '5', barOpen: new Date('2026-11-18T10:00:00Z'), firedAt: new Date('2026-11-18T10:05:01Z'), referencePrice: '4065.20' })
    );
    const res = await webhook.POST(new Request(`http://localhost/v1/webhooks/tradingview/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }), { params: Promise.resolve({ ingressToken: token }) });
    expect(res.status).toBe(202);
    const { eventId } = await res.json();
    const [ev] = await direct.db.select().from(schema.signalEvents).where(eq(schema.signalEvents.id, eventId));
    expect(ev).toMatchObject({ routeId: created.BULLISH_FLIP, sourceExchange: 'BITUNIX', sourceSymbol: 'XAUUSDT.P', instrumentId: bxXau, targetInstrumentIds: [] });
  });

  it('the read-only readiness CLI resolves both actions to Bitunix XAUUSDT only', () => {
    const root = path.resolve(__dirname, '../../../..');
    const out = execFileSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'packages/db/src/cli/route-readiness.ts', '--exchange', 'BITUNIX', '--symbol', 'XAUUSDT.P', '--interval', '5', '--expect-exchange', 'BITUNIX'], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
      encoding: 'utf8'
    });
    expect(out).toMatch(/READY: every action resolves to one route executing only on BITUNIX\. No order was sent\./);
    expect(out).not.toMatch(/MEXC/);
  }, 60_000);
});
