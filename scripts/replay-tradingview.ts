/**
 * Sends the exact SRS §6 (SIG-02) TradingView alert message to the local webhook.
 *
 *   npm run replay -- [--action BULLISH_FLIP|BEARISH_FLIP|CLOSE_LONG|CLOSE_SHORT]
 *                     [--bar-open 2026-11-08T09:15:00Z] [--fired-at <iso>] [--now <iso>]
 *                     [--exchange MEXC] [--symbol BTCUSDT.P] [--interval 15] [--price 65000.5]
 *                     [--repeat 2] [--content-type text/plain|application/json]
 *                     [--url http://localhost:3000] [--print]
 *
 * Defaults target the seeded route (MEXC:BTCUSDT.P, 15m) and the most recently closed bar,
 * fired one second after the bar closed. With real time, an alert is only fresh for the route's
 * max age (120 s by default) after a bar closes. For repeatable runs, start the web app and
 * worker with SIGNAL_TEST_CLOCK=<UTC ISO>; this script then uses the same fixed time. The ingress token comes from DEV_INGRESS_TOKEN in
 * .env and is never printed.
 */
import { loadRootEnv } from '@trendpilot/db';
import { buildTradingViewPayload, lastClosedBarOpen, SIGNAL_ACTIONS, SIGNAL_INTERVALS, type SignalAction, type SignalInterval } from '@trendpilot/domain';

loadRootEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const action = (arg('action') ?? 'BULLISH_FLIP') as SignalAction;
const interval = (arg('interval') ?? '15') as SignalInterval;
if (!SIGNAL_ACTIONS.includes(action)) throw new Error(`--action must be one of ${SIGNAL_ACTIONS.join(', ')}`);
if (!SIGNAL_INTERVALS.includes(interval)) throw new Error('--interval must be 5 or 15');

// The payload clock follows --now, else SIGNAL_TEST_CLOCK (same fixed time as the server), else real time.
const nowArg = arg('now') ?? process.env.SIGNAL_TEST_CLOCK;
const now = nowArg ? new Date(nowArg) : new Date();
const barOpen = arg('bar-open') ? new Date(arg('bar-open')!) : lastClosedBarOpen(now, interval);
const barClose = new Date(barOpen.getTime() + Number(interval) * 60_000);
const firedAt = arg('fired-at') ? new Date(arg('fired-at')!) : new Date(Math.min(barClose.getTime() + 1000, now.getTime()));

const payload = buildTradingViewPayload({
  action,
  exchange: arg('exchange') ?? 'MEXC',
  symbol: arg('symbol') ?? 'BTCUSDT.P',
  interval,
  barOpen,
  firedAt,
  referencePrice: arg('price') ?? '65000.5'
});
const body = JSON.stringify(payload, null, 2);

console.log('Payload (exact SRS template, placeholders resolved):');
console.log(body);
if (flag('print')) process.exit(0);

const token = arg('token') ?? process.env.DEV_INGRESS_TOKEN;
if (!token) throw new Error('Set DEV_INGRESS_TOKEN in .env (or pass --token).');
const base = (arg('url') ?? process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const url = `${base}/v1/webhooks/tradingview/${token}`;
const shown = `${base}/v1/webhooks/tradingview/${token.slice(0, 8)}…(redacted)`;
const contentType = arg('content-type') ?? 'application/json';
const repeat = Math.max(1, Number(arg('repeat') ?? 1));

for (let i = 1; i <= repeat; i++) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': contentType }, body });
  const text = await res.text();
  console.log(`\n#${i} POST ${shown}\n→ ${res.status} ${text}`);
}
