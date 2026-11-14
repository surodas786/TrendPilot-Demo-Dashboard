/**
 * Read-only inspection of one investor's Live position against their MEXC account: why the
 * private sync did (or did not) reconcile a close made directly on MEXC.
 *
 *   npm run ops:live-position-check -- --email investor@… --symbol XAU_USDT [--position <uuid>]
 *
 * Database: one READ ONLY transaction (any write is refused by Postgres). MEXC: the READ_ONLY
 * transport (allowlisted GET queries only; it cannot send, change or cancel an order). Nothing is
 * replayed, retried, booked or sent. Prints the local position, the matching MEXC account and
 * position, MEXC's closing fills and stop, every order intent on the contract, and a diagnosis
 * with the rule of the previous sync that left the position open.
 */
import { sql } from 'drizzle-orm';
import { Decimal } from '@trendpilot/domain';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { connectionFor } from '../live/liveMode';
import { INFLIGHT_CLOSE_GRACE_MS, mexcReadOnly, stopCoverage } from '../live/liveSync';

loadRootEnv();
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const email = arg('email');
const symbol = (arg('symbol') ?? 'XAU_USDT').toUpperCase();
const positionArg = arg('position') ?? null;
if (!email) {
  console.error('Give --email of the investor (and --symbol, default XAU_USDT; optional --position <uuid>).');
  process.exit(2);
}
const D = (v: Decimal.Value) => new Decimal(v);
const UNRESOLVED = ['INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'];
const print = (title: string, rows: unknown[] | Record<string, unknown>) => {
  const list = Array.isArray(rows) ? rows : [rows];
  console.log(`\n## ${title} (${list.length})`);
  if (list.length) console.table(list);
};
const now = new Date();
const h = createDb(requireEnv('DATABASE_URL'), 1);

type Row = Record<string, unknown>;
let conn: Row | undefined;
let pos: Row | undefined;
let intents: Row[] = [];
try {
  await h.db.transaction(
    async (tx) => {
      const q = async (s: ReturnType<typeof sql>) => (await tx.execute(s)).rows as Row[];
      const [user] = await q(sql`SELECT id, email, status, timezone FROM users WHERE lower(email) = lower(${email})`);
      if (!user) throw new Error(`No user ${email}`);
      [conn] = await q(sql`
        SELECT id, owner_id, status, account_ref, key_fingerprint, position_mode, live_enabled, entries_halted, halt_reason, last_sync_at, left(last_sync_error, 200) AS last_sync_error,
               drift, api_key_sealed, secret_sealed
        FROM exchange_connections WHERE owner_id = ${user.id}`);
      const [acct] = await q(sql`SELECT id, mode, wallet_balance, position_margin, order_reserve, exchange_equity, exchange_available, exchange_synced_at FROM paper_accounts WHERE owner_id = ${user.id} AND mode = 'LIVE'`);
      print('Investor', { id: user.id, email: user.email, status: user.status });
      if (conn) {
        const { api_key_sealed: _k, secret_sealed: _s, drift, ...shown } = conn;
        print('Exchange connection (key and secret never printed)', { ...shown, drift: JSON.stringify(drift) });
      } else print('Exchange connection', []);
      if (acct) print('Live account', acct);
      if (!acct) throw new Error('No Live account');

      const positions = await q(sql`
        SELECT p.id, p.mode, p.side, p.status, p.contracts, p.initial_contracts, p.avg_entry_price, p.stop_price, p.stop_order_ref, p.stop_contracts, p.protection_status,
               p.exchange_position_ref, p.exchange_synced_at, p.close_reason, p.closed_at, p.opened_at, p.open_intent_id, p.paper_account_id, p.instrument_id, i.exchange_symbol
        FROM positions p JOIN instruments i ON i.id = p.instrument_id
        WHERE p.owner_id = ${user.id} AND upper(i.exchange_symbol) = ${symbol} ${positionArg ? sql`AND p.id = ${positionArg}::uuid` : sql``}
        ORDER BY p.opened_at DESC LIMIT 5`);
      print(`Positions on ${symbol} (latest first; the stored mode decides Paper/Live)`, positions);
      pos = positions.find((p) => p.status === 'OPEN' && p.mode === 'LIVE') ?? positions.find((p) => p.mode === 'LIVE');
      if (!pos) throw new Error(`No Live position on ${symbol}`);

      intents = await q(sql`
        SELECT o.id, o.kind, o.side, o.state, left(o.state_reason, 120) AS state_reason, o.exit_reason, o.client_order_id, length(o.client_order_id) AS oid_len,
               o.contracts, o.filled_contracts, o.event_id, o.created_at, o.submitted_at, o.resolved_at
        FROM order_intents o
        WHERE o.paper_account_id = ${pos.paper_account_id} AND o.instrument_id = ${pos.instrument_id} AND o.mode = 'LIVE' AND o.created_at >= ${pos.opened_at}::timestamptz - interval '5 minutes'
        ORDER BY o.created_at`);
      print('Live order intents on this contract since the position opened', intents);
      const ids = intents.map((i) => i.id as string);
      if (ids.length) {
        const list = sql.join(ids.map((i) => sql`${i}`), sql`, `);
        print(
          'Jobs for these intents',
          await q(sql`SELECT id, kind, status, attempts, left(last_error, 200) AS last_error, run_after, completed_at FROM jobs WHERE payload->>'intentId' IN (${list}) OR payload->>'closeIntentId' IN (${list}) ORDER BY created_at`)
        );
        print(
          'Reversal opening-leg decisions (ENTRY_V1 after a REVERSAL_CLOSE)',
          await q(sql`SELECT event_id, status, reason, detail->>'closeState' AS close_state, detail->>'remainingContracts' AS remaining, evaluated_at FROM signal_decisions WHERE step = 'ENTRY_V1' AND detail->>'closeIntentId' IN (${list})`)
        );
      }
      print('Exits booked for the position', await q(sql`SELECT reason, exchange_fill_id, contracts, price, fee, realized_pnl, remaining_contracts, intent_id, filled_at FROM position_exits WHERE position_id = ${pos.id} ORDER BY filled_at`));
    },
    { accessMode: 'read only' }
  );
} finally {
  await h.close();
}

if (!conn || !pos) process.exit(1);
const h2 = createDb(requireEnv('DATABASE_URL'), 1);
const connRow = await connectionFor(h2.db, String((conn as Row).owner_id));
await h2.close();
if (!connRow) process.exit(1);
const mexc = mexcReadOnly(connRow); // read-only transport: GET queries on the allowlist only

const findings: string[] = [];
const say = (s: string) => findings.push(s);
const side = String(pos.side);
const platformQty = D(String(pos.contracts));
const openedMs = new Date(String(pos.opened_at)).getTime();

const usdt = (await mexc.assets()).find((a) => a.currency === 'USDT');
print('MEXC USDT balance (this API key)', usdt ? { ...usdt } : []);
const venueAll = await mexc.openPositions();
const venue = venueAll.filter((p) => p.symbol === symbol);
print(`MEXC open positions on ${symbol}`, venue.map((p) => ({ ...p })));
const vp = venue.find((p) => p.open && p.side === side && D(p.contracts).gt(0));
const venueQty = vp ? D(vp.contracts) : D(0);
const stops = await mexc.stops(symbol);
print(`MEXC stop orders listed on ${symbol}`, stops.map((s) => ({ ...s })));
const stopId = String(pos.stop_order_ref ?? '').replace(/^mexc-sl:/, '');
const stop = stops.find((s) => s.stopId === stopId);

const deals = await mexc.deals(symbol, openedMs - 60_000);
const closeSide = side === 'LONG' ? 4 : 2;
const closing = deals.filter((d) => d.side === closeSide && d.timestamp >= openedMs - 60_000);
const byOrder = new Map<string, typeof closing>();
for (const d of closing) byOrder.set(d.orderId, [...(byOrder.get(d.orderId) ?? []), d]);
const orderRows: Row[] = [];
for (const [orderId, ds] of byOrder) {
  const ord = await mexc.order(orderId);
  const vol = ds.reduce((t, d) => t.plus(d.vol), D(0));
  const own = intents.find((i) => ord?.externalOid && i.client_order_id === ord.externalOid);
  orderRows.push({
    orderId,
    externalOid: ord?.externalOid ?? null,
    placedBy: own ? `TrendPilot intent ${own.id} (${own.kind} ${own.state})` : 'MEXC (manual / stop)',
    state: ord?.state ?? 'not listed',
    orderDealVol: ord?.dealVol ?? null,
    listedDealVol: vol.toFixed(),
    avgPrice: ds.reduce((t, d) => t.plus(D(d.price).times(d.vol)), D(0)).div(vol).toDecimalPlaces(8).toFixed(),
    fee: ds.reduce((t, d) => t.plus(d.fee), D(0)).toFixed(),
    profit: ds.every((d) => d.profit !== null) ? ds.reduce((t, d) => t.plus(d.profit!), D(0)).toFixed() : null,
    lastDealAt: new Date(Math.max(...ds.map((d) => d.timestamp))).toISOString()
  });
}
print(`MEXC closing deals (side ${closeSide}) since the position opened, per order`, orderRows);
const closeLookups: Row[] = [];
for (const i of intents.filter((x) => x.kind === 'CLOSE')) {
  try {
    const o = await mexc.orderByClientId(symbol, String(i.client_order_id));
    closeLookups.push({ intent: i.id, clientOrderId: i.client_order_id, atMexc: o ? `${o.state} ${o.dealVol}/${o.vol} (order ${o.orderId})` : 'no such order' });
  } catch (e) {
    closeLookups.push({ intent: i.id, clientOrderId: i.client_order_id, atMexc: `lookup failed: ${(e as Error).message}` });
  }
}
print('TrendPilot close orders looked up at MEXC by client order ID', closeLookups);

// ── Diagnosis ──
say(`Local position ${String(pos.id)}: ${side} ${platformQty.toFixed()} contracts, status ${String(pos.status)}, stored mode ${String(pos.mode)}.`);
say(`MEXC (account ${String(conn.account_ref)}, key …${String(conn.key_fingerprint).replace(/^…/, '')}): ${vp ? `${side} ${venueQty.toFixed()} contracts, positionId ${vp.positionId}` : `no ${side} on ${symbol}`}.`);
if (pos.exchange_position_ref && vp && String(pos.exchange_position_ref) !== vp.positionId) say(`! MEXC positionId ${vp.positionId} differs from the stored ${String(pos.exchange_position_ref)} — a different position.`);
if (pos.exchange_position_ref && !vp) say(`Stored MEXC positionId ${String(pos.exchange_position_ref)} is no longer open at MEXC.`);
if (!pos.exchange_position_ref) say('No MEXC positionId stored: the sync never saw this position at the same size (it was never matched).');
if (conn.status !== 'VERIFIED') say(`! Connection status ${String(conn.status)}: the worker only syncs VERIFIED connections, so this account is not synced at all.`);
if (conn.last_sync_error) say(`! Last sync failed: ${String(conn.last_sync_error)}`);
if (!conn.last_sync_at) say('! The account has never been synced.');
else say(`Last sync attempt: ${new Date(String(conn.last_sync_at)).toISOString()} (${Math.round((now.getTime() - new Date(String(conn.last_sync_at)).getTime()) / 60000)} min ago).`);

const unresolved = intents.filter((i) => UNRESOLVED.includes(String(i.state)));
for (const u of unresolved) {
  const age = now.getTime() - new Date(String(u.submitted_at ?? u.created_at)).getTime();
  say(
    `! Unresolved ${String(u.kind)} intent ${String(u.id)} (${String(u.state)}, ${String(u.exit_reason ?? '')}, ${Math.round(age / 60000)} min old). ` +
      `PREVIOUS SYNC: skipped this position on every run while any order on the contract was unresolved — the manual close was never looked at. ` +
      (u.kind === 'CLOSE' && age >= INFLIGHT_CLOSE_GRACE_MS ? 'NEW SYNC: an unresolved close older than 2 min no longer blocks; its own MEXC order is still left to its job.' : 'NEW SYNC: still waits (an opening order, or a close younger than 2 min).')
  );
}
if (venueQty.eq(platformQty)) say(`MEXC still holds the full ${venueQty.toFixed()} contracts on this API key: the close was not made on this MEXC account (check the account/sub-account), or not yet.`);
else if (venueQty.gt(platformQty)) say('! MEXC holds MORE than TrendPilot: unknown exposure.');
else {
  const gap = platformQty.minus(venueQty);
  const listed = orderRows.reduce((t, r) => t.plus(String(r.listedDealVol)), D(0));
  say(`MEXC holds ${gap.toFixed()} contracts less than TrendPilot (${venueQty.isZero() ? 'fully closed' : 'partly closed'} at MEXC). Closing deals listed: ${listed.toFixed()} contracts in ${orderRows.length} order(s).`);
  if (!orderRows.length) say('No closing deals listed yet. PREVIOUS SYNC: recorded SIZE_MISMATCH drift and halted entries, leaving the position open. NEW SYNC: shows "MEXC confirms closed, fill details pending" (FILLS_PENDING) and books the fills once MEXC lists them.');
  else if (listed.lt(gap)) say('Listed deals cover less than the difference: the rest is booked when MEXC lists it (FILLS_PENDING meanwhile).');
  if (venueQty.isZero() && stop?.state === 'ACTIVE') say(`! Stop ${stop.stopId} is still ACTIVE at MEXC with the position flat. PREVIOUS SYNC: the exit was booked but the position stayed OPEN (with 0 contracts) because the stop was still listed. NEW SYNC: closes it and reports STOP_ORPHANED.`);
}
if (venueQty.gt(0)) say(`Stop ${stopId || '(none stored)'}: ${stop ? `${stop.state}, ${stop.vol} contracts` : 'not listed at MEXC'} → coverage of the ${venueQty.toFixed()} still at MEXC: ${stopCoverage(stop, side, venueQty)}.`);
else say(`Stop ${stopId || '(none stored)'}: ${stop ? `${stop.state}, ${stop.vol} contracts` : 'not listed (expected after a full close)'}.`);

console.log('\n## Diagnosis');
for (const f of findings) console.log(`- ${f}`);
console.log('\nRead-only: nothing was written, booked or sent.');
