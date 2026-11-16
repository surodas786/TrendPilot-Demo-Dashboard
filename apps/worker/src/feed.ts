import { sql } from 'drizzle-orm';
import { hostname } from 'node:os';
import type pg from 'pg';
import {
  BitunixKlineSource,
  BitunixPriceStream,
  BitunixQuoteWriter,
  BITUNIX_WS_PUBLIC_URL,
  createDb,
  ExchangePriceCache,
  heartbeat,
  markStopped,
  MarketFeed,
  MexcPublicClient,
  MexcTickerStream,
  MEXC_PUBLIC_DEFAULT_BASE_URL,
  MEXC_WS_DEFAULT_URL,
  requireEnv,
  type CycleSummary,
  type IngestOutcome,
  type PublicMarketSource,
  type StreamTicker,
  type WsFactory
} from '@trendpilot/db';
import { assertLiveTransportDisabled, bitunixSymbolFor, FEED_POLICY } from '@trendpilot/domain';

/**
 * MKT-01/02 public price feed process (Paper mode). MEXC Futures PUBLIC data only: no credentials,
 * no private endpoints, live order transport stays disabled.
 *
 * Ticker source (MARKET_FEED_TICKER_SOURCE):
 *  - `ws` (default): one public WebSocket (wss://contract.mexc.com/edge) carries `sub.ticker` for
 *    every covered contract. Each `push.ticker` is stored as a MEXC_PUBLIC quote (channel WS) with
 *    its `market.tick` job; the commit NOTIFYs the web app, which pushes it to browsers over SSE.
 *    No routine REST ticker call is made. REST stays for contract detail, closed-candle backfill and
 *    settled funding, and for an optional rate-limited ticker fallback (MARKET_FEED_REST_FALLBACK=on).
 *  - `rest`: the legacy REST polling loop (rollback switch).
 *
 * Only one feed process per database is active (Postgres advisory lock); extra replicas stand by,
 * so scaling the service never multiplies MEXC traffic from one IP.
 */
export interface FeedProcessOptions {
  env?: Record<string, string | undefined>;
  log?: (m: string) => void;
  source?: PublicMarketSource;
  /** WebSocket constructor override (tests). */
  wsFactory?: WsFactory;
}

/** The feed runs on real time. A fixed replay clock would make every live quote look stale or future. */
export function assertRealClock(env: Record<string, string | undefined>): void {
  if (env.SIGNAL_TEST_CLOCK) throw new Error('SIGNAL_TEST_CLOCK is set. The public MEXC feed runs on real time; unset it (fixture replays do not need the feed).');
}

export interface FeedConfig {
  tickerSource: 'ws' | 'rest';
  wsUrl: string;
  restFallback: { enabled: boolean; minIntervalMs: number };
  logTicks: boolean;
  drillDisconnectAfterS: number | null;
  /**
   * Bitunix public prices (Step 1): off unless BITUNIX_PUBLIC_WS=on. Prices go to the in-memory,
   * exchange-keyed cache and the heartbeat only; they are not stored as quotes and drive no orders
   * until Bitunix contracts exist as platform instruments.
   */
  bitunix: { enabled: boolean; wsUrl: string; symbols: string[] };
}

export function feedConfig(env: Record<string, string | undefined>): FeedConfig {
  const tickerSource = (env.MARKET_FEED_TICKER_SOURCE || 'ws').trim().toLowerCase();
  if (tickerSource !== 'ws' && tickerSource !== 'rest') throw new Error(`MARKET_FEED_TICKER_SOURCE must be "ws" or "rest" (got "${tickerSource}").`);
  const wsUrl = env.MEXC_PUBLIC_WS_URL || MEXC_WS_DEFAULT_URL;
  if (!/^wss:\/\//.test(wsUrl) && !(env.NODE_ENV !== 'production' && /^ws:\/\/(127\.0\.0\.1|localhost)[:/]/.test(wsUrl))) throw new Error(`MEXC_PUBLIC_WS_URL must be a wss:// URL (got "${wsUrl}").`);
  const fb = (env.MARKET_FEED_REST_FALLBACK || 'off').trim().toLowerCase();
  if (fb !== 'on' && fb !== 'off') throw new Error(`MARKET_FEED_REST_FALLBACK must be "on" or "off" (got "${fb}").`);
  const minIntervalMs = Math.max(5_000, Number(env.MARKET_FEED_REST_FALLBACK_MIN_MS || FEED_POLICY.restFallbackMinIntervalMs));
  const drill = Number(env.MARKET_FEED_WS_DRILL_DISCONNECT_AFTER_S || '');
  const bx = (env.BITUNIX_PUBLIC_WS || 'off').trim().toLowerCase();
  if (bx !== 'on' && bx !== 'off') throw new Error(`BITUNIX_PUBLIC_WS must be "on" or "off" (got "${bx}").`);
  const bxUrl = env.BITUNIX_PUBLIC_WS_URL || BITUNIX_WS_PUBLIC_URL;
  if (!/^wss:\/\//.test(bxUrl) && !(env.NODE_ENV !== 'production' && /^ws:\/\/(127\.0\.0\.1|localhost)[:/]/.test(bxUrl))) throw new Error(`BITUNIX_PUBLIC_WS_URL must be a wss:// URL (got "${bxUrl}").`);
  const bxSymbols = (env.BITUNIX_WS_SYMBOLS || 'BTCUSDT,XAUUSDT').split(',').map((x) => x.trim());
  const badSymbol = bxSymbols.find((x) => !bitunixSymbolFor(x));
  if (badSymbol !== undefined) throw new Error(`BITUNIX_WS_SYMBOLS has an invalid symbol "${badSymbol}" (use e.g. BTCUSDT,XAUUSDT).`);
  return {
    tickerSource,
    wsUrl,
    restFallback: { enabled: fb === 'on', minIntervalMs },
    logTicks: env.MARKET_FEED_LOG_TICKS === '1',
    drillDisconnectAfterS: Number.isFinite(drill) && drill > 0 ? drill : null,
    bitunix: { enabled: bx === 'on', wsUrl: bxUrl, symbols: [...new Set(bxSymbols.map((x) => bitunixSymbolFor(x)!))] }
  };
}

const summarize = (s: CycleSummary) =>
  `cycle offset=${s.clockOffsetMs ?? '?'}ms ` +
  s.instruments
    .map(
      (r) =>
        `${r.symbol}:${r.state}${r.skipped ? `(rest ${r.skipped.toLowerCase()})` : ''}${r.quoteWritten ? ` quote${r.quoteChannel === 'REST_FALLBACK' ? '(REST fallback)' : ''}` : ''}${r.candlesWritten ? ` candles=${r.candlesWritten}` : ''}${r.gapsBackfilled ? ` backfilled=${r.gapsBackfilled}` : ''}${r.error ? ` error="${r.error}"` : ''}`
    )
    .join(' | ');

const restCallsText = (c: Record<string, number> | undefined) =>
  c ? ['ticker', 'kline', 'detail', 'funding_rate', 'ping'].map((k) => `${k}=${c[k] ?? 0}`).join(' ') : 'n/a';

function setup(o: FeedProcessOptions) {
  const env = o.env ?? process.env;
  assertLiveTransportDisabled(env);
  assertRealClock(env);
  const cfg = feedConfig(env);
  const handle = createDb(env.DATABASE_URL ?? requireEnv('DATABASE_URL'), 3);
  const baseUrl = env.MEXC_PUBLIC_BASE_URL || MEXC_PUBLIC_DEFAULT_BASE_URL;
  const source = o.source ?? new MexcPublicClient({ baseUrl, timeoutMs: Number(env.MARKET_FEED_TIMEOUT_MS ?? 5000) });
  const log = o.log ?? ((m: string) => console.log(`[feed] ${new Date().toISOString()} ${m}`));
  return { env, cfg, handle, source, log, baseUrl };
}

/**
 * Feeds `push.ticker` messages into the MarketFeed. Per contract at most one write is in flight;
 * a newer ticker that arrives meanwhile replaces any waiting one (never a backlog).
 */
class IngestQueue {
  private readonly pending = new Map<string, StreamTicker>();
  private readonly busy = new Set<string>();
  readonly counts = new Map<string, Record<IngestOutcome | 'RECEIVED', number>>();
  private idle: Promise<void> = Promise.resolve();
  private release: (() => void) | null = null;

  constructor(
    private readonly feed: MarketFeed,
    private readonly log: (m: string) => void
  ) {}

  push(t: StreamTicker): void {
    this.bump(t.exchangeSymbol, 'RECEIVED');
    this.pending.set(t.exchangeSymbol, t);
    if (!this.busy.has(t.exchangeSymbol)) void this.drain(t.exchangeSymbol);
  }

  private bump(sym: string, k: IngestOutcome | 'RECEIVED') {
    const c = this.counts.get(sym) ?? { RECEIVED: 0, WRITTEN: 0, REPEAT: 0, STALE: 0, CLOCK_SKEW: 0, IGNORED: 0 };
    c[k] += 1;
    this.counts.set(sym, c);
  }

  private async drain(sym: string): Promise<void> {
    this.busy.add(sym);
    if (this.busy.size === 1) this.idle = new Promise((r) => (this.release = r));
    try {
      for (let t = this.pending.get(sym); t; t = this.pending.get(sym)) {
        this.pending.delete(sym);
        try {
          this.bump(sym, await this.feed.ingestStreamTicker(t));
        } catch (e) {
          this.bump(sym, 'IGNORED');
          this.log(`${sym}: storing WebSocket ticker failed: ${(e as Error).message}`);
        }
      }
    } finally {
      this.busy.delete(sym);
      if (this.busy.size === 0) this.release?.();
    }
  }

  /** Resolves when nothing is being written. */
  settled(): Promise<void> {
    return this.busy.size ? this.idle : Promise.resolve();
  }

  /** Counts since the previous call, then resets. */
  take(): Record<string, Record<string, number>> {
    const out = Object.fromEntries(this.counts);
    this.counts.clear();
    return out;
  }
}

/** One cycle, then exit (`npm run market:feed -- --once`). In ws mode it first waits briefly for tickers. */
export async function runFeedOnce(o: FeedProcessOptions = {}): Promise<CycleSummary> {
  const { cfg, handle, source, log, baseUrl } = setup(o);
  let stream: MexcTickerStream | null = null;
  try {
    await handle.db.execute(sql`select 1`);
    if (cfg.tickerSource === 'rest') {
      const feed = new MarketFeed(handle.db, { source, log });
      log(`public MEXC feed (${baseUrl}), REST ticker polling, one cycle; live order transport disabled`);
      const s = await feed.cycle();
      log(summarize(s));
      return s;
    }
    const s0: MexcTickerStream = new MexcTickerStream({ url: cfg.wsUrl, factory: o.wsFactory, log, logTicks: cfg.logTicks, onTicker: (t) => queue.push(t), onClockSample: (ms) => feed.setClockOffset(ms) });
    stream = s0;
    const feed = new MarketFeed(handle.db, { source, log, stream: s0, restFallback: cfg.restFallback });
    const queue = new IngestQueue(feed, log);
    log(`public MEXC feed, WebSocket ${cfg.wsUrl} + REST ${baseUrl} (candles/detail/funding), one cycle; live order transport disabled`);
    const symbols = await feed.refreshCoverage();
    stream.setSymbols(symbols);
    stream.start();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !symbols.every((s) => (queue.counts.get(s)?.WRITTEN ?? 0) + (queue.counts.get(s)?.REPEAT ?? 0) > 0)) await new Promise((r) => setTimeout(r, 200));
    await queue.settled();
    const s = await feed.cycle();
    log(summarize(s));
    log(`REST calls: ${restCallsText(source.requestCounts)}`);
    return s;
  } finally {
    stream?.stop();
    await handle.close();
  }
}

export interface RunningFeed {
  stop: () => Promise<void>;
  /** Drill: drop the WebSocket as if the network failed (ws mode only). */
  forceDisconnect: (reason?: string) => void;
}

const FEED_LOCK_KEY = 'trendpilot.market-feed';

/**
 * Holds a session advisory lock on a dedicated connection while this process is the active feed.
 * Returns once acquired; until then reports itself as a standby replica.
 */
async function acquireFeedLock(pool: pg.Pool, log: (m: string) => void, standby: () => Promise<void>, stopped: () => boolean): Promise<pg.PoolClient | null> {
  let warned = false;
  for (;;) {
    if (stopped()) return null;
    const client = await pool.connect();
    try {
      const r = await client.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [FEED_LOCK_KEY]);
      if (r.rows[0]?.ok) {
        client.on('error', (e) => {
          log(`feed lock connection lost (${e.message}); exiting so a single active feed is re-elected`);
          process.exit(70);
        });
        return client;
      }
    } catch (e) {
      client.release();
      throw e;
    }
    client.release();
    if (!warned) log('another market feed process holds the feed lock; standing by (no MEXC calls from this replica)');
    warned = true;
    await standby().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

export async function startFeed(o: FeedProcessOptions = {}): Promise<RunningFeed> {
  const { env, cfg, handle, source, log, baseUrl } = setup(o);
  await handle.db.execute(sql`select 1`);
  const pollMs = Math.max(1000, Number(env.MARKET_FEED_POLL_MS ?? 2000));
  const instance = `feed-${hostname()}-${process.pid}`;
  const startedAt = new Date();
  let stopping = false;

  const lock = await acquireFeedLock(
    handle.pool,
    log,
    () => heartbeat(handle.db, { service: 'market-feed', instance, startedAt, detail: { role: 'standby' } }),
    () => stopping
  );
  if (!lock) throw new Error('stopped before acquiring the feed lock');

  let feed!: MarketFeed;
  let queue: IngestQueue | null = null;
  let stream: MexcTickerStream | null = null;
  if (cfg.tickerSource === 'ws') {
    stream = new MexcTickerStream({ url: cfg.wsUrl, factory: o.wsFactory, log, logTicks: cfg.logTicks, onTicker: (t) => queue!.push(t), onClockSample: (ms) => feed.setClockOffset(ms) });
    feed = new MarketFeed(handle.db, { source, log, stream, restFallback: cfg.restFallback });
    queue = new IngestQueue(feed, log);
    log(
      `public MEXC feed started: tickers via WebSocket ${cfg.wsUrl} (primary); REST ${baseUrl} for candles, contract detail and funding only; REST ticker fallback ${cfg.restFallback.enabled ? `ON (≤1 per contract per ${cfg.restFallback.minIntervalMs} ms)` : 'off'}; cycle every ${pollMs} ms; live order transport disabled`
    );
    stream.setSymbols(await feed.refreshCoverage());
    stream.start();
  } else {
    feed = new MarketFeed(handle.db, { source, log });
    log(`public MEXC feed started: REST ticker polling (${baseUrl}) every ${pollMs} ms [MARKET_FEED_TICKER_SOURCE=rest]; live order transport disabled`);
  }

  // Bitunix public prices (opt-in): own socket, own exchange-keyed cache entries; MEXC is untouched.
  const prices = new ExchangePriceCache();
  // Bitunix instruments (published, or with an open position) get BITUNIX_PUBLIC quotes from this stream.
  const bitunixQuotes = new BitunixQuoteWriter(handle.db, prices, { log });
  const bitunixSymbols = async () => [...new Set([...cfg.bitunix.symbols, ...(await bitunixQuotes.refresh())])];
  let bitunix: BitunixPriceStream | null = null;
  // Bitunix closed 5m/15m candles (EMA 200) for Bitunix instruments: the shared candle sync on its
  // own BITUNIX_PUBLIC history (never mixed with MEXC candles).
  const bitunixCandles = cfg.bitunix.enabled
    ? new MarketFeed(handle.db, { source: new BitunixKlineSource({ baseUrl: env.BITUNIX_PUBLIC_BASE_URL || undefined }), exchange: 'BITUNIX', log: (m) => log(`bitunix candles: ${m}`) })
    : null;
  let lastBitunixCandles = 0;
  let bitunixCandleSummary: unknown = null;
  if (cfg.bitunix.enabled) {
    bitunix = new BitunixPriceStream({
      url: cfg.bitunix.wsUrl,
      factory: o.wsFactory,
      log: (m) => log(`bitunix ${m}`),
      logTicks: cfg.logTicks,
      onTicker: (t) => {
        prices.putBook('BITUNIX', t.exchangeSymbol, t);
        void bitunixQuotes.onUpdate(t.exchangeSymbol);
      },
      onPrice: (p) => {
        prices.putMark('BITUNIX', p.exchangeSymbol, p);
        void bitunixQuotes.onUpdate(p.exchangeSymbol);
      },
      onUnsupported: (sym) => prices.forget('BITUNIX', sym)
    });
    const syms = await bitunixSymbols();
    bitunix.setSymbols(syms);
    bitunix.start();
    log(`Bitunix public prices: WebSocket ${cfg.bitunix.wsUrl} for ${syms.join(', ')} (quotes stored for Bitunix instruments: ${bitunixQuotes.symbols().join(', ') || 'none yet'})`);
  } else if ((await bitunixQuotes.refresh()).length) {
    log(`WARNING: Bitunix instruments exist (${bitunixQuotes.symbols().join(', ')}) but BITUNIX_PUBLIC_WS is off: they get no quotes, so Bitunix entries expire as FEED_STALE.`);
  }
  const bitunixDetail = () => {
    if (!bitunix) return null;
    const at = new Date();
    return {
      stream: bitunix.status(),
      quotes: cfg.bitunix.symbols.map((sym) => {
        const q = prices.quote('BITUNIX', sym, at);
        return { symbol: sym, state: q.state, problem: q.problem, bid: q.bid, ask: q.ask, last: q.last, mark: q.mark, asOf: q.asOf?.toISOString() ?? null };
      })
    };
  };

  let busy: Promise<void> = Promise.resolve();
  let lastLine = '';
  let lastBeat = 0;
  let lastStats = Date.now();
  const tick = async () => {
    if (stopping) return;
    try {
      // Subscribe newly published contracts first, so their tickers do not wait for REST backfill.
      if (stream) stream.setSymbols(await feed.refreshCoverage());
      if (bitunix) bitunix.setSymbols(await bitunixSymbols());
      if (bitunixCandles && Date.now() - lastBitunixCandles >= 15_000) {
        lastBitunixCandles = Date.now();
        const r = await bitunixCandles.candleCycle();
        bitunixCandleSummary = r;
        for (const x of r) if (x.error || x.backfilled) log(`bitunix candles ${x.symbol} ${x.interval}m: written=${x.written} backfilled=${x.backfilled}${x.error ? ` error="${x.error}"` : ''}`);
      }
      const s = await feed.cycle();
      stream?.setSymbols(feed.coveredExchangeSymbols);
      if (Date.now() - lastBeat >= 15_000) {
        lastBeat = Date.now();
        const paused = feed.restPausedUntil;
        const detail = {
          role: 'active',
          baseUrl,
          tickerSource: cfg.tickerSource,
          restFallback: cfg.tickerSource === 'ws' ? cfg.restFallback.enabled : null,
          clockOffsetMs: s.clockOffsetMs,
          stream: stream?.status() ?? null,
          restCalls: { ...(source.requestCounts ?? {}) },
          restPausedUntil: paused ? new Date(paused).toISOString() : null,
          contracts: s.instruments.map((r) => ({ symbol: r.symbol, state: r.state, error: r.error ?? null })),
          ...(bitunix ? { bitunix: { ...bitunixDetail(), candles: bitunixCandleSummary } } : {})
        };
        await heartbeat(handle.db, { service: 'market-feed', instance, startedAt, detail }).catch((e) => log(`heartbeat failed: ${(e as Error).message}`));
      }
      if (queue && Date.now() - lastStats >= 60_000) {
        const secs = Math.round((Date.now() - lastStats) / 1000);
        lastStats = Date.now();
        const st = stream!.status();
        const per = Object.entries(queue.take())
          .map(([sym, c]) => `${sym} received=${c.RECEIVED} written=${c.WRITTEN} repeat=${c.REPEAT}${c.STALE ? ` stale=${c.STALE}` : ''}${c.IGNORED ? ` ignored=${c.IGNORED}` : ''}`)
          .join('; ');
        log(`ws: state=${st.state} subscribed=[${st.subscribed.join(',')}] confirmed=[${st.confirmed.join(',')}] reconnects=${st.reconnects} last ${secs}s: ${per || 'no tickers'} | REST calls since start: ${restCallsText(source.requestCounts)}`);
      }
      const line = summarize(s);
      // Log changes, not every identical cycle.
      const shape = line.replace(/ quote(\(REST fallback\))?/g, '').replace(/offset=-?\d+ms/, '');
      if (shape !== lastLine) log(line);
      lastLine = shape;
    } catch (e) {
      log(`cycle failed: ${(e as Error).message}`);
    }
  };
  await tick();
  const timer = setInterval(() => (busy = busy.then(tick)), pollMs);

  const forceDisconnect = (reason = 'drill') => stream?.forceDisconnect(reason);
  const drillTimer = stream && cfg.drillDisconnectAfterS ? setTimeout(() => forceDisconnect(`drill: forced disconnect after ${cfg.drillDisconnectAfterS} s (MARKET_FEED_WS_DRILL_DISCONNECT_AFTER_S)`), cfg.drillDisconnectAfterS * 1000) : null;

  return {
    forceDisconnect,
    stop: async () => {
      stopping = true;
      clearInterval(timer);
      if (drillTimer) clearTimeout(drillTimer);
      stream?.stop();
      bitunix?.stop();
      await busy;
      await queue?.settled();
      await markStopped(handle.db, 'market-feed', instance).catch(() => undefined);
      lock.release(true); // destroying the connection drops the advisory lock
      await handle.close();
      log('stopped');
    }
  };
}
