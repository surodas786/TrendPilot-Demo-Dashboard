/**
 * Writes deterministic market fixtures (closed candles + one quote) for local replay.
 *
 *   npm run market:fixture -- --scenario up|down|flat|gap|none [--at <UTC ISO>]
 *                              [--symbol BTCUSDT] [--interval 15] [--count 260] [--close 65000]
 *
 * up/down: a trend ending at --close, so the signal bar closes above/below EMA 200.
 * flat:    constant closes, so close == EMA 200 (equality blocks entry).
 * gap:     like "up" but with a missing candle 50 bars back (insufficient consecutive history).
 * none:    removes this contract's candles and quotes (missing history, stale feed).
 *
 * Candles end at the most recently closed bar at --at (default: SIGNAL_TEST_CLOCK, else now),
 * i.e. the bar the replay command sends. The quote is stamped --at.
 */
import { eq } from 'drizzle-orm';
import { lastClosedBarOpen, type SignalInterval } from '@trendpilot/domain';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { clearMarketData, writeMarketFixture } from '../paper/market';
import { instruments } from '../schema';

loadRootEnv();
if (process.env.NODE_ENV === 'production') throw new Error('Market fixtures are for development and tests only.');

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const scenario = arg('scenario') ?? 'up';
if (!['up', 'down', 'flat', 'gap', 'none'].includes(scenario)) throw new Error('--scenario must be up, down, flat, gap or none');
const at = new Date(arg('at') ?? process.env.SIGNAL_TEST_CLOCK ?? new Date().toISOString());
const interval = (arg('interval') ?? '15') as SignalInterval;
const symbol = (arg('symbol') ?? 'BTCUSDT').toUpperCase();

const url = process.env.MARKET_DATABASE_URL ?? requireEnv('DATABASE_URL');
const h = createDb(url, 1);
try {
  const [inst] = await h.db.select().from(instruments).where(eq(instruments.symbol, symbol));
  if (!inst) throw new Error(`Unknown instrument ${symbol}`);
  if (scenario === 'none') {
    await clearMarketData(h.db, inst.id);
    console.log(`Cleared fixture candles and quotes for ${symbol}.`);
  } else {
    const endBarOpen = lastClosedBarOpen(at, interval);
    const intervalMs = Number(interval) * 60_000;
    const r = await writeMarketFixture(h.db, {
      instrumentId: inst.id,
      interval,
      endBarOpen,
      count: Number(arg('count') ?? 260),
      endClose: arg('close') ?? '65000',
      trend: scenario === 'down' ? 'DOWN' : scenario === 'flat' ? 'FLAT' : 'UP',
      omit: scenario === 'gap' ? [new Date(endBarOpen.getTime() - 50 * intervalMs)] : [],
      quoteAt: at
    });
    console.log(`FIXTURE market data for ${symbol} ${interval}m (${scenario}): ${r.candles} closed candles ending at bar ${endBarOpen.toISOString()}, quote as of ${at.toISOString()}.`);
  }
} finally {
  await h.close();
}
