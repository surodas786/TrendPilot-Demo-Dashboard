/**
 * Paper staging smoke test, end to end over HTTPS (Step 10).
 *
 *   SMOKE_BASE_URL=https://staging.example.com \
 *   SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… [SMOKE_ADMIN_TOTP_SECRET=…] \
 *   SMOKE_INVESTOR_PASSWORD=… \
 *   SMOKE_OPS_MAIL_CMD="docker compose -f docker-compose.staging.yml --env-file .env.staging exec -T web npm run --silent ops:mail --" \
 *   npm run staging:smoke
 *
 * Uses only the public HTTP API, plus the operator mail-relay command for invite links (no SMTP
 * in this build). It is idempotent: it creates whatever is missing, and reuses everything else.
 *  1. /v1/health; admin sign-in.
 *  2. Setup: publish BTCUSDT; a 5m Supertrend version (EMA off); the TradingView webhook (a fresh
 *     token each run, never printed); a 5m BULLISH_FLIP route; two investors (smoke-a and smoke-b)
 *     with different sizes and exits; their Paper blocks active.
 *  3. Waits for a healthy public MEXC feed, then for the next 5m bar close. Sends ONE alert through
 *     the HTTPS webhook at the live public price, then the same alert again (must be a duplicate).
 *  4. Both investors get their own paper position with an attached stop; sizes differ; no
 *     cross-investor access; dashboards reconcile.
 *  5. Closes both positions manually, checks the exits and the ledger, and checks Operations
 *     for errors. Leaves the configuration in place for the next run.
 * Paper only: no exchange credentials are used, and no order leaves the paper simulator.
 * For a local rehearsal with Caddy's internal CA, also set NODE_TLS_REJECT_UNAUTHORIZED=0.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- this script reads untyped JSON from a remote deployment; every value it relies on is checked explicitly below */
import { execSync } from 'node:child_process';
import { buildTradingViewPayload, lastClosedBarOpen, PAPER_TEMPLATE } from '@trendpilot/domain';
import { totp } from '@trendpilot/db';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === '') throw new Error(`${k} is required`);
  return v;
};
const BASE = env('SMOKE_BASE_URL').replace(/\/+$/, '');
const ADMIN = { email: env('SMOKE_ADMIN_EMAIL'), password: env('SMOKE_ADMIN_PASSWORD') };
const INVESTOR_PASSWORD = env('SMOKE_INVESTOR_PASSWORD');
const MAIL_CMD = env('SMOKE_OPS_MAIL_CMD');
const SUFFIX = process.env.SMOKE_EMAIL_DOMAIN ?? 'paper-smoke.invalid';
const INVESTORS = {
  a: { email: `smoke-a@${SUFFIX}`, name: 'Smoke Investor A', block: { orderCostUsdt: '20', leverage: 5, stop: { type: 'PERCENT', value: '1.5', basis: 'MARK' }, takeProfit: { mode: 'FIXED', levels: [{ id: 'tp1', movePct: '3', closePct: '100' }] } } },
  b: { email: `smoke-b@${SUFFIX}`, name: 'Smoke Investor B', block: { orderCostUsdt: '10', leverage: 3, stop: { type: 'PERCENT', value: '2', basis: 'LAST' }, takeProfit: { mode: 'OFF', levels: [] } } }
} as const;
const PACKAGE = 'Paper smoke Supertrend';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, path: string, o: { cookie?: string; body?: unknown; ifMatch?: number; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { accept: 'application/json', ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.ifMatch !== undefined) headers['if-match'] = `"${o.ifMatch}"`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), redirect: 'manual' });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, setCookie: res.headers.get('set-cookie') };
}

async function signIn(email: string, password: string, totpSecret?: string): Promise<string> {
  const r = await api('POST', '/v1/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`sign-in ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  let cookie = r.setCookie!.split(';')[0]!;
  if (r.body.mfaRequired) {
    if (!totpSecret) throw new Error(`${email} has MFA on: set SMOKE_ADMIN_TOTP_SECRET`);
    const m = await api('POST', '/v1/auth/mfa', { cookie, body: { code: totp.totpAt(totpSecret, totp.timeStep()) } });
    if (m.status !== 200) throw new Error(`MFA ${email}: ${m.status}`);
    cookie = m.setCookie!.split(';')[0]!;
  }
  return cookie;
}

const inviteToken = (email: string): string => {
  const out = execSync(`${MAIL_CMD} --to ${email} --template INVITE`, { encoding: 'utf8' });
  const m = /#token=([A-Za-z0-9_-]+)/.exec(out);
  if (!m) throw new Error(`No invite link for ${email}`);
  return m[1]!;
};

async function main() {
  console.log(`Paper staging smoke against ${BASE}\n`);
  // 1. Health
  const h = await api('GET', '/v1/health');
  check('health: web and database up, Paper, live transport disabled', h.status === 200 && h.body?.database === 'up' && h.body?.mode === 'PAPER' && h.body?.liveOrderTransport === 'disabled', JSON.stringify(h.body));
  const admin = await signIn(ADMIN.email, ADMIN.password, process.env.SMOKE_ADMIN_TOTP_SECRET);
  check('admin sign-in over HTTPS', true);

  // 2. Setup (idempotent)
  let btc = (await api('GET', '/v1/admin/instruments', { cookie: admin })).body.items.find((i: any) => i.symbol === 'BTCUSDT');
  if (!btc) {
    const r = await api('POST', '/v1/admin/instruments', { cookie: admin, body: { symbol: 'BTCUSDT', suggestedStopPct: '1.5', suggestedTakeProfitPct: '3', suggestedTrailingEnabled: false, suggestedTrailingPct: '1' } });
    if (r.status !== 201) throw new Error(`create BTCUSDT: ${r.status} ${JSON.stringify(r.body)}`);
    btc = r.body;
  }
  if (btc.status !== 'PUBLISHED') btc = (await api('PATCH', `/v1/admin/instruments/${btc.id}`, { cookie: admin, ifMatch: btc.revision, body: { status: 'PUBLISHED' } })).body;
  check('BTCUSDT published', btc.status === 'PUBLISHED');

  let pkg = (await api('GET', '/v1/admin/strategy-packages', { cookie: admin })).body.items.find((p: any) => p.name === PACKAGE);
  if (!pkg) pkg = (await api('POST', '/v1/admin/strategy-packages', { cookie: admin, body: { name: PACKAGE } })).body;
  pkg = (await api('GET', '/v1/admin/strategy-packages', { cookie: admin })).body.items.find((p: any) => p.id === pkg.id);
  let version = (pkg.versions ?? []).find((v: any) => v.status === 'PUBLISHED' && v.timeframe === '5m' && v.emaFilter === 'OFF');
  if (!version) {
    const d = await api('POST', `/v1/admin/strategy-packages/${pkg.id}/versions`, { cookie: admin, body: { ...PAPER_TEMPLATE, timeframe: '5m', instrumentIds: [btc.id] } });
    if (d.status !== 201) throw new Error(`version draft: ${d.status} ${JSON.stringify(d.body)}`);
    const p = await api('POST', `/v1/admin/strategy-versions/${d.body.id}/publish`, { cookie: admin, ifMatch: d.body.revision });
    if (p.status !== 200) throw new Error(`publish: ${p.status} ${JSON.stringify(p.body)}`);
    version = p.body;
  }
  check('5m strategy version published (EMA off)', !!version?.id, `v${version.version}`);

  const hook = await api('POST', '/v1/admin/webhook/rotate', { cookie: admin });
  const webhookUrl: string = hook.body.url;
  check('webhook URL issued over HTTPS (fresh token; only the hint is shown)', hook.status === 200 && webhookUrl.startsWith('https://'), `hint ${hook.body.tokenHint}`);
  const webhookPath = new URL(webhookUrl).pathname;

  const routes = (await api('GET', '/v1/admin/signal-routes', { cookie: admin })).body.items;
  const hasRoute = routes.some((r: any) => r.sourceExchange === 'MEXC' && r.sourceSymbol === 'BTCUSDT.P' && r.interval === '5' && r.action === 'BULLISH_FLIP' && r.enabled !== false);
  if (!hasRoute) {
    const r = await api('POST', '/v1/admin/signal-routes', {
      cookie: admin,
      body: { name: 'Smoke BTC 5m bullish', sourceExchange: 'MEXC', sourceSymbol: 'BTCUSDT.P', interval: '5', action: 'BULLISH_FLIP', kind: 'ACTIONABLE', instrumentId: btc.id, packageId: pkg.id, maxSignalAgeSeconds: 120, clockToleranceSeconds: 5 }
    });
    if (r.status !== 201) throw new Error(`route: ${r.status} ${JSON.stringify(r.body)}`);
  }
  check('route MEXC:BTCUSDT.P 5m BULLISH_FLIP → BTCUSDT', true);

  const cookies: Record<'a' | 'b', string> = { a: '', b: '' };
  for (const k of ['a', 'b'] as const) {
    const inv = INVESTORS[k];
    let u = (await api('GET', '/v1/admin/users', { cookie: admin })).body.items.find((x: any) => x.email === inv.email);
    if (!u) u = (await api('POST', '/v1/admin/users', { cookie: admin, body: { name: inv.name, email: inv.email } })).body;
    if (u.status === 'INVITED') {
      const a = await api('POST', '/v1/auth/invite/accept', { body: { token: inviteToken(inv.email), password: INVESTOR_PASSWORD } });
      if (a.status !== 204) throw new Error(`accept invite ${inv.email}: ${a.status} ${JSON.stringify(a.body)}`);
    }
    cookies[k] = await signIn(inv.email, INVESTOR_PASSWORD);
    const blocks = (await api('GET', '/v1/me/order-blocks', { cookie: cookies[k] })).body.items;
    let b = blocks.find((x: any) => x.instrumentId === btc.id && x.mode === 'PAPER');
    const settings = {
      instrumentId: btc.id,
      strategyVersionId: version.id,
      mode: 'PAPER',
      direction: 'BOTH',
      marginMode: 'ISOLATED',
      trailing: { enabled: false, activationPct: null, distancePct: null, basis: 'MARK' },
      weekdays: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
      allowAdds: false,
      maxAdds: null,
      risk: { maxOpenPositions: null, maxNotionalUsdt: null, maxStopRiskUsdt: null, dailyLossLimitUsdt: null, cooldownMinutes: null, maxSpreadPct: null, maxPriceDeviationPct: null },
      ...inv.block
    };
    if (!b) {
      const c = await api('POST', '/v1/me/order-blocks', { cookie: cookies[k], body: settings });
      if (c.status !== 201) throw new Error(`block ${k}: ${c.status} ${JSON.stringify(c.body)}`);
      b = c.body;
    } else if (b.strategyVersionId !== version.id) {
      const { instrumentId: _i, mode: _m, ...patch } = settings;
      b = (await api('PATCH', `/v1/me/order-blocks/${b.id}`, { cookie: cookies[k], ifMatch: b.revision, body: patch })).body;
    }
    if (b.status !== 'ACTIVE') b = (await api('POST', `/v1/me/order-blocks/${b.id}/resume`, { cookie: cookies[k], ifMatch: b.revision })).body;
    check(`investor ${k.toUpperCase()} ready (Paper block ACTIVE, ${inv.block.orderCostUsdt} USDT × ${inv.block.leverage})`, b.status === 'ACTIVE');
  }

  // Close anything left open by an earlier, interrupted run.
  for (const k of ['a', 'b'] as const) {
    for (const p of (await api('GET', '/v1/me/holdings', { cookie: cookies[k] })).body.positions) {
      await api('POST', `/v1/me/positions/${p.id}/close`, { cookie: cookies[k], headers: { 'idempotency-key': `smoke-pre-${p.id}` } });
    }
  }

  // 3. Feed, then one alert at the next bar close.
  let quote: any = null;
  for (let i = 0; i < 30 && !quote; i++) {
    const ops = (await api('GET', '/v1/admin/operations', { cookie: admin })).body;
    const c = ops.feed.contracts.find((x: any) => x.symbol === 'BTCUSDT');
    if (c?.feed?.state === 'HEALTHY' && c.latestQuote?.source === 'MEXC_PUBLIC' && c.latestQuote.freshness === 'FRESH') quote = c.latestQuote;
    else await sleep(2000);
  }
  if (!check('public MEXC feed healthy with a fresh BTC price', !!quote, quote ? `mark ${quote.mark}, ${quote.ageSeconds} s old` : 'no fresh MEXC_PUBLIC quote within 60 s')) return;

  const now = Date.now();
  const nextClose = Math.ceil(now / 300_000) * 300_000;
  const waitMs = nextClose + 2_000 - now;
  console.log(`\nWaiting ${Math.round(waitMs / 1000)} s for the 5m bar to close at ${new Date(nextClose).toISOString()} …`);
  await sleep(waitMs);
  const ops = (await api('GET', '/v1/admin/operations', { cookie: admin })).body;
  const price = ops.feed.contracts.find((x: any) => x.symbol === 'BTCUSDT').latestQuote.mark as string;
  const firedAt = new Date();
  const barOpen = lastClosedBarOpen(firedAt, '5');
  const payload = JSON.stringify(buildTradingViewPayload({ action: 'BULLISH_FLIP', exchange: 'MEXC', symbol: 'BTCUSDT.P', interval: '5', barOpen, firedAt, referencePrice: price }));
  const send = () => fetch(`${BASE}${webhookPath}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const first = await send();
  check('alert accepted through the HTTPS webhook', first.status === 202 && first.body?.status === 'accepted', `${first.status} ${JSON.stringify(first.body)}`);
  const dup = await send();
  check('same alert again is a duplicate', dup.status === 200 && dup.body?.status === 'duplicate', `${dup.status}`);

  // 4. Positions per investor.
  const pos: Record<'a' | 'b', any> = { a: null, b: null };
  for (let i = 0; i < 45 && (!pos.a || !pos.b); i++) {
    for (const k of ['a', 'b'] as const) {
      const hs = (await api('GET', '/v1/me/holdings', { cookie: cookies[k] })).body.positions;
      pos[k] = hs.find((p: any) => p.symbol === 'BTCUSDT' && p.status === 'OPEN') ?? null;
    }
    if (!pos.a || !pos.b) await sleep(2000);
  }
  if (!check('both investors got a paper position from the one alert', !!pos.a && !!pos.b)) {
    for (const k of ['a', 'b'] as const) console.log(k, JSON.stringify((await api('GET', '/v1/me/signals', { cookie: cookies[k] })).body.items?.[0] ?? null));
    return;
  }
  for (const k of ['a', 'b'] as const) {
    const p = pos[k];
    check(`${k.toUpperCase()}: stop attached and covering the position`, p.stop.protection === 'PROTECTED' && Number(p.stop.contracts) === Number(p.contracts), `${p.contracts} contracts, stop ${p.stop.price} (${p.stop.basis})`);
    check(`${k.toUpperCase()}: priced from public MEXC data`, p.price?.source === 'MEXC_PUBLIC', `${p.price?.source} ${p.price?.freshness}`);
  }
  check('different sizes per investor', Number(pos.a.contracts) !== Number(pos.b.contracts), `A ${pos.a.contracts}, B ${pos.b.contracts}`);
  check("A cannot read B's trade", (await api('GET', `/v1/me/trades/${pos.b.id}`, { cookie: cookies.a })).status === 404);
  check("B cannot close A's position", (await api('POST', `/v1/me/positions/${pos.a.id}/close`, { cookie: cookies.b, headers: { 'idempotency-key': `smoke-x-${pos.a.id}` } })).status === 404);

  // 5. Close both, verify exits and ledger.
  for (const k of ['a', 'b'] as const) await api('POST', `/v1/me/positions/${pos[k].id}/close`, { cookie: cookies[k], headers: { 'idempotency-key': `smoke-close-${pos[k].id}` } });
  for (const k of ['a', 'b'] as const) {
    let t: any = null;
    for (let i = 0; i < 30; i++) {
      t = (await api('GET', `/v1/me/trades/${pos[k].id}`, { cookie: cookies[k] })).body;
      if (t.status === 'CLOSED') break;
      await sleep(2000);
    }
    check(`${k.toUpperCase()}: manual close filled (exit reason, fee, realized P&L recorded)`, t.status === 'CLOSED' && t.exits.length === 1 && t.closeReason === 'MANUAL_CLOSE', `realized ${t.realizedPnlUsdt}, fees ${t.feesUsdt}`);
    const d = (await api('GET', '/v1/me/dashboard', { cookie: cookies[k] })).body;
    check(`${k.toUpperCase()}: dashboard reconciles with the ledger`, d.reconciliation.ok === true, `wallet ${d.account.walletUsdt}, net today ${d.daily.netRealizedUsdt}`);
  }
  const after = (await api('GET', '/v1/admin/operations', { cookie: admin })).body;
  check('operations: no errors, worker and feed reporting', !after.alerts.some((a: any) => a.level === 'ERROR') && after.serviceSummary.worker === 'REPORTING' && after.serviceSummary['market-feed'] === 'REPORTING', after.alerts.map((a: any) => a.message).join(' | ') || 'no alerts');
}

try {
  await main();
} catch (e) {
  check('smoke run', false, (e as Error).message);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => f.name).join('; ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
