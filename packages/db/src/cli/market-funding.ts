/**
 * Records one SETTLED funding rate for a contract (deterministic fixture) and queues its booking.
 *
 *   npm run market:funding -- --rate 0.0001 --at 2026-11-08T08:00:00Z [--symbol BTCUSDT]
 *
 * The worker then books simulated funding to every paper position open at that settlement, at
 * the newest mark price at or before it (paid negative, received positive). Re-running the same
 * command books nothing new. Also run `npm run market:tick -- --at <settlement>` first if no
 * quote exists near the settlement time (otherwise funding stays unavailable).
 */
import { eq } from 'drizzle-orm';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { recordFundingRate } from '../paper/funding';
import { instruments } from '../schema';

loadRootEnv();
if (process.env.NODE_ENV === 'production') throw new Error('Funding fixtures are for development and tests only.');

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const rate = arg('rate');
const at = arg('at');
if (!rate || !at) throw new Error('--rate and --at are required');
const settledAt = new Date(at);
if (Number.isNaN(settledAt.getTime()) || settledAt.getTime() % (8 * 3_600_000) !== 0) throw new Error('--at must be a funding settlement time (00:00, 08:00 or 16:00 UTC)');
const symbol = (arg('symbol') ?? 'BTCUSDT').toUpperCase();

const h = createDb(process.env.MARKET_DATABASE_URL ?? requireEnv('DATABASE_URL'), 1);
try {
  const [inst] = await h.db.select().from(instruments).where(eq(instruments.symbol, symbol));
  if (!inst) throw new Error(`Unknown instrument ${symbol}`);
  const r = await recordFundingRate(h.db, { instrumentId: inst.id, settledAt, rate, source: 'FIXTURE' });
  console.log(`FIXTURE settled funding ${symbol} ${rate} at ${settledAt.toISOString()}${r.created ? '' : ' (already recorded)'}. Run npm run worker:once.`);
} finally {
  await h.close();
}
