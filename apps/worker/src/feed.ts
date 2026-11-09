import { sql } from 'drizzle-orm';
import { hostname } from 'node:os';
import { createDb, heartbeat, markStopped, MarketFeed, MexcPublicClient, MEXC_PUBLIC_DEFAULT_BASE_URL, requireEnv, type CycleSummary, type PublicMarketSource } from '@trendpilot/db';
import { assertLiveTransportDisabled } from '@trendpilot/domain';

/**
 * MKT-01/02 public price feed process (Paper mode). Polls MEXC Futures PUBLIC endpoints only and
 * writes quotes and closed candles with source MEXC_PUBLIC. The worker turns each quote's
 * `market.tick` job into stop, target and trailing checks. No credentials, no private endpoints,
 * and live order transport stays disabled.
 */
export interface FeedProcessOptions {
  env?: Record<string, string | undefined>;
  log?: (m: string) => void;
  source?: PublicMarketSource;
}

/** The feed runs on real time. A fixed replay clock would make every live quote look stale or future. */
export function assertRealClock(env: Record<string, string | undefined>): void {
  if (env.SIGNAL_TEST_CLOCK) throw new Error('SIGNAL_TEST_CLOCK is set. The public MEXC feed runs on real time; unset it (fixture replays do not need the feed).');
}

const summarize = (s: CycleSummary) =>
  `cycle offset=${s.clockOffsetMs ?? '?'}ms ` +
  s.instruments.map((r) => `${r.symbol}:${r.state}${r.skipped ? '(backoff)' : ''}${r.quoteWritten ? ' quote' : ''}${r.candlesWritten ? ` candles=${r.candlesWritten}` : ''}${r.gapsBackfilled ? ` backfilled=${r.gapsBackfilled}` : ''}${r.error ? ` error="${r.error}"` : ''}`).join(' | ');

function setup(o: FeedProcessOptions) {
  const env = o.env ?? process.env;
  assertLiveTransportDisabled(env);
  assertRealClock(env);
  const handle = createDb(env.DATABASE_URL ?? requireEnv('DATABASE_URL'), 2);
  const baseUrl = env.MEXC_PUBLIC_BASE_URL || MEXC_PUBLIC_DEFAULT_BASE_URL;
  const source = o.source ?? new MexcPublicClient({ baseUrl, timeoutMs: Number(env.MARKET_FEED_TIMEOUT_MS ?? 5000) });
  const log = o.log ?? ((m: string) => console.log(`[feed] ${new Date().toISOString()} ${m}`));
  const feed = new MarketFeed(handle.db, { source, log });
  return { env, handle, feed, log, baseUrl };
}

/** One cycle, then exit (`npm run market:feed -- --once`). */
export async function runFeedOnce(o: FeedProcessOptions = {}): Promise<CycleSummary> {
  const { handle, feed, log, baseUrl } = setup(o);
  try {
    await handle.db.execute(sql`select 1`);
    log(`public MEXC feed (${baseUrl}), one cycle; live order transport disabled`);
    const s = await feed.cycle();
    log(summarize(s));
    return s;
  } finally {
    await handle.close();
  }
}

export interface RunningFeed {
  stop: () => Promise<void>;
}

export async function startFeed(o: FeedProcessOptions = {}): Promise<RunningFeed> {
  const { env, handle, feed, log, baseUrl } = setup(o);
  await handle.db.execute(sql`select 1`);
  const pollMs = Math.max(1000, Number(env.MARKET_FEED_POLL_MS ?? 2000));
  log(`public MEXC feed started (${baseUrl}), every ${pollMs} ms; live order transport disabled`);
  let stopping = false;
  let busy: Promise<void> = Promise.resolve();
  let lastLine = '';
  const instance = `feed-${hostname()}-${process.pid}`;
  const startedAt = new Date();
  let lastBeat = 0;
  const tick = async () => {
    if (stopping) return;
    try {
      const s = await feed.cycle();
      if (Date.now() - lastBeat >= 15_000) {
        lastBeat = Date.now();
        const detail = { baseUrl, clockOffsetMs: s.clockOffsetMs, contracts: s.instruments.map((r) => ({ symbol: r.symbol, state: r.state, error: r.error ?? null })) };
        await heartbeat(handle.db, { service: 'market-feed', instance, startedAt, detail }).catch((e) => log(`heartbeat failed: ${(e as Error).message}`));
      }
      const line = summarize(s);
      // Log changes, not every identical cycle.
      const shape = line.replace(/ quote/g, '').replace(/offset=-?\d+ms/, '');
      if (shape !== lastLine) log(line);
      lastLine = shape;
    } catch (e) {
      log(`cycle failed: ${(e as Error).message}`);
    }
  };
  await tick();
  const timer = setInterval(() => (busy = busy.then(tick)), pollMs);
  return {
    stop: async () => {
      stopping = true;
      clearInterval(timer);
      await busy;
      await markStopped(handle.db, 'market-feed', instance).catch(() => undefined);
      await handle.close();
      log('stopped');
    }
  };
}
