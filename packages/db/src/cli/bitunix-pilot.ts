/**
 * Supervised Bitunix live pilot (Step 5). See docs/BITUNIX_PILOT_RUNBOOK.md before running.
 *
 *   npm run ops:bitunix-pilot -- --investor <email> --symbol BTCUSDT --max-exposure 20 [--stop-pct 2] [--basis MARK]
 *       Dry run (default): checks every precondition and prints the exact four payloads, the smallest
 *       exchange-valid quantity, stops, exposure and margin. Sends NO order.
 *
 *   … --execute --evidence-out <file>
 *       Sends the four Hedge-mode orders through the Live Bitunix venue. Refused unless this process
 *       may open the live order transport (NODE_ENV=production and LIVE_ORDER_TRANSPORT=enabled) and
 *       the operator recorded the two Bitunix order capabilities as PILOT_ACCEPTED. Writes sanitized
 *       evidence and prints its reference (bitunix-pilot:<sha256>) for Admin → Live Trading.
 */
import { writeFileSync } from 'node:fs';
import { and, desc, eq } from 'drizzle-orm';
import { Decimal } from '@trendpilot/domain';
import { createDb } from '../client';
import { loadRootEnv } from '../env';
import { bitunixCredentialsOf } from '../live/bitunixConnection';
import { BitunixOrderTransport, bitunixVenue, parseTradingSettings } from '../live/bitunixOrders';
import { pilotReference, planBitunixPilot, runBitunixPilot } from '../live/bitunixPilot';
import { BitunixReadOnlyTransport } from '../live/bitunixPrivate';
import { capabilityStateOf, connectionFor, getLiveControl } from '../live/liveMode';
import { openLiveOrderTransport } from '../live/mexcPrivate';
import { instruments, marketQuotes, paperAccounts, users } from '../schema';

loadRootEnv();
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const email = arg('investor');
const symbol = (arg('symbol') ?? 'BTCUSDT').toUpperCase();
const maxExposure = arg('max-exposure');
const stopPct = arg('stop-pct') ?? '2';
const basis = (arg('basis') ?? 'MARK').toUpperCase() as 'MARK' | 'LAST';
const execute = process.argv.includes('--execute');
const evidenceOut = arg('evidence-out');
const fail = (m: string): never => {
  console.log(`REFUSED: ${m}`);
  process.exit(2);
};
if (!email || !maxExposure) fail('--investor <email> and --max-exposure <USDT> are required.');
if (execute && !evidenceOut) fail('--execute needs --evidence-out <file>.');

const h = createDb(process.env.DATABASE_URL!, 2);
try {
  const db = h.db;
  const [u] = await db.select().from(users).where(eq(users.email, email!));
  if (!u || u.role !== 'INVESTOR') fail(`${email} is not an investor.`);
  const conn = await connectionFor(db, u!.id, 'BITUNIX');
  const checks: [string, boolean, string][] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push([name, ok, detail]);
  check('Bitunix connection verified', conn?.status === 'VERIFIED', conn?.status ?? 'none');
  check('Hedge mode (reported by Bitunix)', conn?.positionMode === 'HEDGE', conn?.positionMode ?? 'unknown');
  check('connection approved with limits', !!conn?.approvedAt, conn?.maxExposureUsdt ? `max exposure ${conn.maxExposureUsdt} USDT` : 'not approved');
  check('pilot exposure within the approved limit', !!conn?.maxExposureUsdt && new Decimal(maxExposure!).lte(conn.maxExposureUsdt), `${maxExposure} ≤ ${conn?.maxExposureUsdt ?? '?'}`);
  const [inst] = await db.select().from(instruments).where(and(eq(instruments.exchange, 'BITUNIX'), eq(instruments.symbol, symbol)));
  check('Bitunix instrument published, on the Live allowlist, exchange-verified', !!inst && inst.status === 'PUBLISHED' && inst.liveAllowed && !inst.isFixture, inst ? `${inst.status} liveAllowed=${inst.liveAllowed} fixture=${inst.isFixture}` : 'missing');
  const control = await getLiveControl(db);
  const caps = capabilityStateOf(control);
  for (const c of ['BITUNIX_OPEN_WITH_ATTACHED_STOP', 'BITUNIX_HEDGE_CLOSE_BY_POSITION'] as const) check(`capability ${c} recorded (PILOT_ACCEPTED or VERIFIED)`, caps[c] === 'VERIFIED', caps[c] ?? 'not recorded');
  const [acct] = await db.select().from(paperAccounts).where(and(eq(paperAccounts.ownerId, u!.id), eq(paperAccounts.mode, 'LIVE'), eq(paperAccounts.exchange, 'BITUNIX')));
  check('Bitunix Live account synced', !!acct?.exchangeSyncedAt, acct?.exchangeAvailable ? `available ${acct.exchangeAvailable} USDT` : 'never synced');
  const [q] = inst ? await db.select().from(marketQuotes).where(and(eq(marketQuotes.instrumentId, inst.id), eq(marketQuotes.source, 'BITUNIX_PUBLIC'))).orderBy(desc(marketQuotes.asOf)).limit(1) : [];
  const fresh = !!q && Date.now() - q.asOf.getTime() < 15_000;
  check('fresh Bitunix price (feed with BITUNIX_PUBLIC_WS=on)', fresh, q ? `${q.bid}/${q.ask} at ${q.asOf.toISOString()}` : 'no quote');

  // Settings are read, never changed: both legs must already use the same leverage.
  let leverage = 0;
  let marginMode: 'ISOLATED' | 'CROSS' = 'ISOLATED';
  if (conn && conn.status === 'VERIFIED' && inst) {
    try {
      const read = new BitunixReadOnlyTransport({ credentials: bitunixCredentialsOf(conn), baseUrl: process.env.BITUNIX_PRIVATE_BASE_URL || undefined });
      const s = parseTradingSettings(await read.get('/api/v1/futures/account/trading_settings', { symbols: symbol }), symbol);
      leverage = s?.longLeverage ?? s?.leverage ?? 0;
      marginMode = s?.marginMode === 'CROSS' ? 'CROSS' : 'ISOLATED';
      check('Bitunix leverage equal on both legs', !!s && s.longLeverage === s.shortLeverage && leverage > 0, s ? `long ${s.longLeverage}x short ${s.shortLeverage}x ${s.marginMode}` : 'no settings');
    } catch (e) {
      check('Bitunix trading settings readable', false, (e as Error).message);
    }
  }

  const plan = inst && q
    ? planBitunixPilot({ symbol, contract: { symbol, qtyStep: inst.qtyStep, minQty: inst.minQty, maxQty: inst.maxQty, priceTick: inst.priceTick, takerFeeRate: inst.takerFeeRate }, quote: { bid: q.bid, ask: q.ask }, leverage: leverage || 1, marginMode, stopPct, basis, maxExposureUsdt: maxExposure!, clientIdPrefix: `tpx-pilot-${Date.now().toString(36)}` })
    : null;
  console.log('== Preconditions ==');
  for (const [n, ok, d] of checks) console.log(`${ok ? 'OK  ' : 'FAIL'} ${n}: ${d}`);
  console.log('\n== Plan ==');
  console.log(JSON.stringify(plan, null, 2));
  const allOk = checks.every((c) => c[1]) && !!plan?.ok;
  if (!execute) {
    console.log(`\nDRY RUN: no order was sent. ${allOk ? 'All preconditions pass.' : 'Fix the FAIL lines before --execute.'}`);
    process.exit(allOk ? 0 : 1);
  }
  if (!allOk) fail('preconditions failed (see above); nothing was sent.');
  openLiveOrderTransport(process.env); // throws unless NODE_ENV=production and LIVE_ORDER_TRANSPORT=enabled
  const requester = new BitunixOrderTransport({ credentials: bitunixCredentialsOf(conn!), baseUrl: process.env.BITUNIX_PRIVATE_BASE_URL || undefined });
  const venue = bitunixVenue({
    requester,
    contractFor: async () => ({ symbol, qtyStep: inst!.qtyStep, minQty: inst!.minQty, maxQty: inst!.maxQty, priceTick: inst!.priceTick, takerFeeRate: inst!.takerFeeRate }),
    capabilities: caps
  });
  const ev = await runBitunixPilot(venue, requester, { ...plan!, symbol, contract: { symbol, qtyStep: inst!.qtyStep, minQty: inst!.minQty, maxQty: inst!.maxQty, priceTick: inst!.priceTick, takerFeeRate: inst!.takerFeeRate }, quote: { bid: q!.bid, ask: q!.ask }, leverage, marginMode, stopPct, basis, maxExposureUsdt: maxExposure!, clientIdPrefix: `tpx-pilot-${Date.now().toString(36)}`, instrumentId: inst!.id, paperAccountId: acct!.id });
  writeFileSync(evidenceOut!, JSON.stringify(ev, null, 2));
  console.log(`\n== Evidence written to ${evidenceOut} ==`);
  for (const s of ev.steps) console.log(`${s.ok ? 'OK  ' : 'FAIL'} ${s.step}`);
  console.log(`\nReference for Admin → Live Trading (capability evidence): ${pilotReference(ev)}`);
  console.log('Record a Bitunix capability as VERIFIED only if its steps above are OK and the evidence was reviewed.');
} finally {
  await h.close();
}
