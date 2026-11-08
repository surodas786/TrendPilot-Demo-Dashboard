/**
 * Replays one price for a contract (deterministic fixture tick) and queues it for the worker.
 *
 *   npm run market:tick -- --price 67000 [--mark <p>] [--last <p>] [--liquidity <contracts>]
 *                          [--at <UTC ISO>] [--symbol BTCUSDT] [--half-spread 0.5]
 *
 * The worker then lets the simulator trigger resting stops (on each stop's saved basis),
 * records those stop fills, and requests fixed-TP market closes for positions whose target
 * is reached. --at defaults to SIGNAL_TEST_CLOCK (else now), so it is the newest quote the
 * simulator sees when filling closes.
 */
import { eq } from 'drizzle-orm';
import { Decimal } from '@trendpilot/domain';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { recordMarketTick } from '../paper/exits';
import { instruments } from '../schema';

loadRootEnv();
if (process.env.NODE_ENV === 'production') throw new Error('Market ticks are fixtures for development and tests only.');

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const price = arg('price');
if (!price) throw new Error('--price is required');
const half = arg('half-spread') ?? '0.5';
const at = new Date(arg('at') ?? process.env.SIGNAL_TEST_CLOCK ?? new Date().toISOString());
const symbol = (arg('symbol') ?? 'BTCUSDT').toUpperCase();

const h = createDb(process.env.MARKET_DATABASE_URL ?? requireEnv('DATABASE_URL'), 1);
try {
  const [inst] = await h.db.select().from(instruments).where(eq(instruments.symbol, symbol));
  if (!inst) throw new Error(`Unknown instrument ${symbol}`);
  const tick = {
    instrumentId: inst.id,
    asOf: at,
    bid: new Decimal(price).minus(half).toFixed(),
    ask: new Decimal(price).plus(half).toFixed(),
    mark: arg('mark') ?? price,
    last: arg('last') ?? price,
    liquidityContracts: arg('liquidity') ?? null
  };
  await recordMarketTick(h.db, tick);
  console.log(
    `FIXTURE tick ${symbol} @ ${at.toISOString()}: bid ${tick.bid} / ask ${tick.ask}, mark ${tick.mark}, last ${tick.last}${tick.liquidityContracts ? `, liquidity ${tick.liquidityContracts} contracts` : ''}. Run npm run worker:once.`
  );
} finally {
  await h.close();
}
