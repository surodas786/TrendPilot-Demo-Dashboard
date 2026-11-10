// Deterministic paper replay harness: a controlled clock, fixture prices and the real job loop.
import { and, eq, sql } from 'drizzle-orm';
import { processNextJob, recordMarketTick, schema, writeMarketFixture } from '@trendpilot/db';
import { buildTradingViewPayload, Decimal, PAPER_TEMPLATE, type SignalAction } from '@trendpilot/domain';
import * as webhook from '@/app/v1/webhooks/tradingview/[ingressToken]/route';
import * as blocks from '@/app/v1/me/order-blocks/route';
import * as resume from '@/app/v1/me/order-blocks/[id]/resume/route';
import * as packages from '@/app/v1/admin/strategy-packages/route';
import * as versions from '@/app/v1/admin/strategy-packages/[id]/versions/route';
import * as publish from '@/app/v1/admin/strategy-versions/[id]/publish/route';
import { setTestClock } from '@/server/clock';
import { BTC, blockBody, call, direct, resetAndSeed, signIn, userId, USERS, VERSION } from './helpers';

export const M15 = 15 * 60_000;
export const ALL_DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
export const plus = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
export const D = (v: Decimal.Value) => new Decimal(v);

export const clock = { now: new Date('2026-11-08T09:30:03Z') };
export const cookies = { a: '', b: '', admin: '' };

export async function deliver(action: SignalAction, barOpen: Date, referencePrice = '65000.5') {
  const token = process.env.DEV_INGRESS_TOKEN!;
  const raw = JSON.stringify(
    buildTradingViewPayload({ action, exchange: 'MEXC', symbol: 'BTCUSDT.P', interval: '15', barOpen, firedAt: plus(new Date(barOpen.getTime() + M15), 1), referencePrice })
  );
  const res = await webhook.POST(new Request(`http://localhost/v1/webhooks/tradingview/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }), {
    params: Promise.resolve({ ingressToken: token })
  });
  return res.status;
}

export const work = (now = clock.now, hooks?: Parameters<typeof processNextJob>[1]['hooks'], db = direct.db) => processNextJob(db, { workerId: 'test', now, hooks });

export async function drain(now = clock.now, db = direct.db, hooks?: Parameters<typeof processNextJob>[1]['hooks']) {
  const out = [];
  for (let i = 0; i < 40; i++) {
    const r = await work(now, hooks, db);
    if (r.outcome === 'IDLE') break;
    out.push(r);
  }
  return out;
}

/** A replayed price; the clock moves to it (default +10 s). */
export async function tick(mid: string, o: { mark?: string; last?: string; liquidity?: string; at?: Date } = {}) {
  clock.now = o.at ?? plus(clock.now, 10);
  await recordMarketTick(direct.db, {
    instrumentId: BTC,
    asOf: clock.now,
    bid: D(mid).minus('0.5').toFixed(),
    ask: D(mid).plus('0.5').toFixed(),
    mark: o.mark ?? mid,
    last: o.last ?? mid,
    liquidityContracts: o.liquidity ?? null
  });
}

export const positionsOf = async (email: string) =>
  direct.db.select().from(schema.positions).where(eq(schema.positions.ownerId, await userId(email))).orderBy(schema.positions.openedAt, schema.positions.createdAt);
export const openPositionOf = async (email: string) => (await positionsOf(email)).find((p) => p.status === 'OPEN');
export const targetsOf = (positionId: string) => direct.db.select().from(schema.positionTargets).where(eq(schema.positionTargets.positionId, positionId)).orderBy(schema.positionTargets.ordinal);
export const exitsOf = (positionId: string) => direct.db.select().from(schema.positionExits).where(eq(schema.positionExits.positionId, positionId)).orderBy(schema.positionExits.filledAt, schema.positionExits.createdAt);
export const closeIntentsOf = (positionId: string) =>
  direct.db.select().from(schema.orderIntents).where(and(eq(schema.orderIntents.kind, 'CLOSE'), eq(schema.orderIntents.positionId, positionId))).orderBy(schema.orderIntents.createdAt);
export const stopOf = async (p: { stopOrderRef: string | null }) => (await direct.db.select().from(schema.simOrders).where(eq(schema.simOrders.clientOrderId, p.stopOrderRef!)))[0]!;
export const venue = async () => (await direct.db.select().from(schema.simPositions)).map((v) => ({ side: v.side, contracts: D(v.contracts).toFixed() }));
export const reconciled = async () => {
  const r = await direct.db.execute(sql`SELECT * FROM paper_account_reconciliation`);
  return (r.rows as any[]).every((x) => D(x.wallet_balance).eq(x.ledger_wallet) && D(x.position_margin).eq(x.ledger_position_margin) && D(x.order_reserve).eq(x.ledger_order_reserve));
};
export const n = (v: string | null) => (v === null ? null : D(v).toFixed());

export async function publishVersion(o: Record<string, unknown>): Promise<string> {
  const pkgs = await call(packages.GET, { path: '/x', cookie: cookies.admin });
  const pkgId = pkgs.body.items.find((p: any) => p.versions.some((v: any) => v.id === VERSION)).id;
  const d = await call(versions.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: pkgId }, body: { ...PAPER_TEMPLATE, instrumentIds: [BTC], ...o } });
  const p = await call(publish.POST, { method: 'POST', path: '/x', cookie: cookies.admin, params: { id: d.body.id }, ifMatch: d.body.revision });
  return p.body.id;
}

export interface OpenOptions {
  side?: 'LONG' | 'SHORT';
  bar?: Date;
  at?: Date;
  /** Per investor block overrides (a version can be a function of the admin session). */
  a?: Record<string, unknown> | null;
  b?: Record<string, unknown> | null;
  version?: () => Promise<string>;
  /** Replaces the fixture candles and quote (e.g. a public-feed cycle against a stub exchange). */
  market?: () => Promise<void>;
  /** Fixture close for the signal bar (quote = close ± 0.5) and the alert's reference price. Default 65000. */
  price?: string;
  /** Job hooks for the opening drain (e.g. an injected venue). */
  hooks?: Parameters<typeof processNextJob>[1]['hooks'];
}

/**
 * Fresh DB; investors with a block (null = no block) open a paper position from one shared alert.
 * Defaults: A 100 USDT ×10, stop 1.5 % MARK; B 50 USDT ×5, stop 3 % LAST; both every day.
 */
export async function openFromAlert(o: OpenOptions = {}) {
  const bar = o.bar ?? new Date('2026-11-08T09:15:00Z');
  await resetAndSeed();
  clock.now = o.at ?? plus(new Date(bar.getTime() + M15), 3);
  setTestClock(() => clock.now);
  cookies.a = await signIn(USERS.investorA.email);
  cookies.b = await signIn(USERS.investorB.email);
  cookies.admin = await signIn(USERS.admin.email);
  const versionId = o.version ? await o.version() : VERSION;
  const blocksOut: Record<string, any> = {};
  const defaults = {
    a: { orderCostUsdt: '100', leverage: 10 },
    b: { orderCostUsdt: '50', leverage: 5, stop: { type: 'PERCENT', value: '3', basis: 'LAST' } }
  };
  for (const who of ['a', 'b'] as const) {
    if (o[who] === null) continue;
    const created = await call(blocks.POST, { method: 'POST', path: '/x', cookie: cookies[who], body: blockBody({ strategyVersionId: versionId, weekdays: ALL_DAYS, ...defaults[who], ...o[who] }) });
    if (created.status !== 201) throw new Error(`block for ${who}: ${JSON.stringify(created.body)}`);
    blocksOut[who] = (await call(resume.POST, { method: 'POST', path: '/x', cookie: cookies[who], params: { id: created.body.id }, ifMatch: created.body.revision })).body;
  }
  if (o.market) await o.market();
  else await writeMarketFixture(direct.db, { instrumentId: BTC, interval: '15', endBarOpen: bar, count: 260, endClose: o.price ?? '65000', trend: o.side === 'SHORT' ? 'DOWN' : 'UP', quoteAt: clock.now });
  if ((await deliver(o.side === 'SHORT' ? 'BEARISH_FLIP' : 'BULLISH_FLIP', bar, o.price ?? '65000.5')) !== 202) throw new Error('alert not accepted');
  await drain(clock.now, direct.db, o.hooks);
  return blocksOut;
}
