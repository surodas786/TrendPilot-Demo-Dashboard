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
 *     in the environment. Two signed GETs (position mode, USDT account) on the read-only transport;
 *     nothing can be placed or changed. Keys are never printed. Otherwise reported as PENDING.
 *
 *   npm run ops:bitunix-check -- [--symbols BTCUSDT,XAUUSDT] [--ws-seconds 15] [--drill] [--public-only]
 */
import { loadRootEnv } from '../env';
import { BITUNIX_PRIVATE_DEFAULT_BASE_URL, bitunixReadOnlyCheck, BitunixReadOnlyTransport } from '../live/bitunixPrivate';
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
  try {
    const r = await bitunixReadOnlyCheck(new BitunixReadOnlyTransport({ credentials: { apiKey, secretKey }, baseUrl: process.env.BITUNIX_PRIVATE_BASE_URL || BITUNIX_PRIVATE_DEFAULT_BASE_URL }));
    line(`OK   signed requests accepted`);
    line(`OK   position mode (reported by Bitunix): ${r.positionMode} (raw "${r.positionModeRaw}")${r.accountPositionMode ? `; the account endpoint reports ${r.accountPositionMode}` : ''}`);
    line(r.usdt ? `OK   USDT: available ${r.usdt.available}, frozen ${r.usdt.frozen}, margin ${r.usdt.margin}, unrealized ${r.usdt.unrealized}, equity ${r.usdt.equity}` : 'WARN no USDT futures account returned');
  } catch (e) {
    failed = true;
    line(`FAIL ${(e as Error).message}`);
  }
}

process.exit(failed ? 1 : 0);
