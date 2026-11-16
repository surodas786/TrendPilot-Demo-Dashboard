/**
 * Bitunix Futures connectivity check (Step 1, read-only). Three parts, each reported separately:
 *
 *  1. PUBLIC contracts: `trading_pairs` for the symbols (default BTCUSDT, XAUUSDT): open,
 *     API-enabled, precision, minimum opening quantity, maximum market order, leverage range.
 *  2. PUBLIC WebSocket: subscribes `tickers` + `price` on wss://fapi.bitunix.com/public/ for
 *     `--ws-seconds` (default 15) and reports per symbol whether bid/ask/last and mark arrived and
 *     the joined quote state from the exchange-keyed cache. `--drill` drops the socket half-way to
 *     exercise reconnect + resubscribe against the real server.
 *  3. PRIVATE read-only: ONLY when BITUNIX_READONLY_API_KEY and BITUNIX_READONLY_SECRET_KEY are set
 *     in the environment. (a) The connection check (position mode, USDT account). (b) A complete
 *     account snapshot (open positions, pending orders, pending TP/SL) and the last 24 h of fills,
 *     orders and position history. (c) The private WebSocket: login (Unix-seconds signature), the
 *     channel subscription, and every push received for `--private-ws-seconds` (default 20).
 *     Read-only transport and a listen-only socket: nothing can be placed, cancelled or changed.
 *     Keys, signatures and login frames are never printed. Otherwise reported as PENDING.
 *
 *   npm run ops:bitunix-check -- [--symbols BTCUSDT,XAUUSDT] [--ws-seconds 15] [--drill] [--public-only] [--private-ws-seconds 20]
 */
import { loadRootEnv } from '../env';
import { readHistoryOrders, readHistoryPositions, readHistoryTrades, takeBitunixSnapshot } from '../live/bitunixAccount';
import { BITUNIX_PRIVATE_DEFAULT_BASE_URL, bitunixReadOnlyCheck, BitunixReadOnlyTransport } from '../live/bitunixPrivate';
import { BitunixPrivateStream } from '../live/bitunixPrivateWs';
import { BitunixPublicClient, discoverBitunixContracts } from '../market/bitunixPublic';
import { BitunixPriceStream } from '../market/bitunixWs';
import { ExchangePriceCache } from '../market/priceCache';

loadRootEnv();
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const symbols = (arg('symbols') ?? 'BTCUSDT,XAUUSDT')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const wsSeconds = Math.max(3, Number(arg('ws-seconds') ?? 15));
const drill = process.argv.includes('--drill');
const publicOnly = process.argv.includes('--public-only');
const privateWsSeconds = Math.max(5, Number(arg('private-ws-seconds') ?? 20));
let failed = false;
const line = (s: string) => console.log(s);

/* 1. Public contracts */
line(`== Bitunix public contracts (${symbols.join(', ')}) ==`);
try {
  const d = await discoverBitunixContracts(new BitunixPublicClient({ baseUrl: process.env.BITUNIX_PUBLIC_BASE_URL || undefined }), symbols);
  for (const [s, r] of Object.entries(d.results)) {
    if (r.ok) {
      const c = r.contract;
      line(`OK   ${s}: status ${c.symbolStatus}, API ${c.isApiSupported ? 'enabled' : 'disabled'}, qty step ${c.qtyStep} (${c.basePrecision} dp, base coin), price tick ${c.priceTick}, min open ${c.minTradeVolume}, max market ${c.maxMarketOrderVolume ?? '—'}, leverage ${c.minLeverage ?? '?'}–${c.maxLeverage ?? '?'}x${r.warnings.length ? ` | ${r.warnings.join(' ')}` : ''}`);
    } else {
      failed = true;
      line(`FAIL ${s}: ${r.reason}: ${r.message}`);
    }
  }
} catch (e) {
  failed = true;
  line(`FAIL trading_pairs: ${(e as Error).message}`);
}

/* 2. Public WebSocket */
line(`\n== Bitunix public WebSocket (${wsSeconds} s${drill ? ', reconnect drill' : ''}) ==`);
{
  const cache = new ExchangePriceCache();
  const counts = new Map<string, { book: number; mark: number }>();
  const bump = (s: string, k: 'book' | 'mark') => counts.set(s, { book: 0, mark: 0, ...counts.get(s), [k]: (counts.get(s)?.[k] ?? 0) + 1 });
  const offsets: number[] = [];
  const stream = new BitunixPriceStream({
    url: process.env.BITUNIX_PUBLIC_WS_URL || undefined,
    onTicker: (t) => {
      bump(t.exchangeSymbol, 'book');
      cache.putBook('BITUNIX', t.exchangeSymbol, t);
    },
    onPrice: (p) => {
      bump(p.exchangeSymbol, 'mark');
      cache.putMark('BITUNIX', p.exchangeSymbol, p);
    },
    onClockSample: (ms) => offsets.push(ms),
    log: (m) => line(`  ${new Date().toISOString()} ${m}`)
  });
  stream.setSymbols(symbols);
  stream.start();
  if (drill) setTimeout(() => stream.forceDisconnect('reconnect drill'), (wsSeconds * 1000) / 2);
  await new Promise((r) => setTimeout(r, wsSeconds * 1000));
  const st = stream.status();
  stream.stop();
  line(`socket: ${st.state === 'STOPPED' ? 'closed after the run' : st.state}, reconnects ${st.reconnects}, pongs ${st.lastPongAt ? 'yes' : 'no'}, clock offset ${offsets.length ? `${offsets.at(-1)} ms` : 'n/a'}, unsupported ${st.unsupported.join(',') || 'none'}`);
  for (const s of symbols) {
    const c = counts.get(s) ?? { book: 0, mark: 0 };
    const q = cache.quote('BITUNIX', s, new Date());
    const ok = c.book > 0 && c.mark > 0 && q.state === 'FRESH' && (!drill || st.confirmed.includes(s));
    if (!ok) failed = true;
    line(`${ok ? 'OK  ' : 'FAIL'} ${s}: tickers ${c.book}, price ${c.mark}; cache ${q.state}${q.problem ? ` (${q.problem})` : ''} bid ${q.bid ?? '—'} ask ${q.ask ?? '—'} last ${q.last ?? '—'} mark ${q.mark ?? '—'} index ${q.index ?? '—'}${drill ? `; resubscribed after drill: ${st.confirmed.includes(s) ? 'yes' : 'no'}` : ''}`);
  }
}

/* 3. Private read-only */
line('\n== Bitunix private read-only check ==');
const apiKey = process.env.BITUNIX_READONLY_API_KEY ?? '';
const secretKey = process.env.BITUNIX_READONLY_SECRET_KEY ?? '';
if (publicOnly || !apiKey || !secretKey) {
  line(`PENDING: ${publicOnly ? '--public-only given' : 'no Bitunix read-only key configured (BITUNIX_READONLY_API_KEY / BITUNIX_READONLY_SECRET_KEY unset)'}. No signed request was sent.`);
} else {
  const t = new BitunixReadOnlyTransport({ credentials: { apiKey, secretKey }, baseUrl: process.env.BITUNIX_PRIVATE_BASE_URL || BITUNIX_PRIVATE_DEFAULT_BASE_URL });
  try {
    const r = await bitunixReadOnlyCheck(t);
    line(`OK   signed requests accepted`);
    line(`OK   position mode (reported by Bitunix): ${r.positionMode} (raw "${r.positionModeRaw}")${r.accountPositionMode ? `; the account endpoint reports ${r.accountPositionMode}` : ''}`);
    line(r.usdt ? `OK   USDT: available ${r.usdt.available}, frozen ${r.usdt.frozen}, margin ${r.usdt.margin}, unrealized ${r.usdt.unrealized}, equity ${r.usdt.equity}` : 'WARN no USDT futures account returned');
  } catch (e) {
    failed = true;
    line(`FAIL connection check: ${(e as Error).message}`);
  }

  line('\n== Bitunix private REST snapshot (read-only) ==');
  try {
    const s = await takeBitunixSnapshot(t);
    line(`OK   complete snapshot: ${s.positions.length} open position(s), ${s.pendingOrders.length} pending order(s), ${s.tpsl.length} pending TP/SL; sub-account rows excluded: ${s.excludedSubAccountRows}`);
    for (const p of s.positions) line(`     ${p.symbol} ${p.side} id ${p.positionId} qty ${p.qty} @ ${p.avgOpenPrice ?? '?'} lev ${p.leverage ?? '?'} liq ${p.liqPrice ?? '—'}`);
    const since = Date.now() - 24 * 3_600_000;
    const [trades, orders, hist] = [await readHistoryTrades(t, { startTime: since }), await readHistoryOrders(t, { startTime: since }), await readHistoryPositions(t, { startTime: since })];
    line(`OK   last 24 h: ${trades.items.length} fill(s), ${orders.items.length} finished order(s), ${hist.items.length} closed position(s)`);
  } catch (e) {
    failed = true;
    line(`FAIL snapshot: ${(e as Error).message}`);
  }

  line(`\n== Bitunix private WebSocket (${privateWsSeconds} s, listen only) ==`);
  const counts: Record<string, number> = {};
  let authFailure: string | null = null;
  let readyAt: Date | null = null;
  const ws = new BitunixPrivateStream({
    url: process.env.BITUNIX_PRIVATE_WS_URL || undefined,
    credentials: () => ({ apiKey, secretKey }),
    onEvent: (e) => {
      counts[e.channel] = (counts[e.channel] ?? 0) + 1;
      line(`  ← ${e.channel} ${'event' in e ? e.event : ''} ${'status' in e ? e.status : ''} ${'symbol' in e ? e.symbol : ''}`.trimEnd());
    },
    onReady: (at) => (readyAt = at),
    onAuthFailed: (m) => (authFailure = m),
    log: (m) => line(`  ${new Date().toISOString()} ${m}`)
  });
  ws.start();
  await new Promise((r) => setTimeout(r, privateWsSeconds * 1000));
  const st = ws.status();
  ws.stop();
  if (authFailure) {
    failed = true;
    line(`FAIL login rejected by Bitunix: ${authFailure}`);
  } else if (!readyAt) {
    failed = true;
    line(`FAIL no login answer (state ${st.state}, auth ${st.auth}${st.lastError ? `, ${st.lastError}` : ''})`);
  } else {
    line(`OK   login accepted (Unix-seconds signature) and channels subscribed; pong ${st.lastPongAt ? 'yes' : 'no'}; reconnects ${st.reconnects}`);
    line(`INFO pushes received: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ') || 'none (normal for an idle account: no position, order or balance change during the window)'}`);
  }
}

process.exit(failed ? 1 : 0);
