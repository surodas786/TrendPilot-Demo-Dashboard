/**
 * Read-only trace of rejected Live CLOSE orders (14 Nov 2026, XAU_USDT: trailing take profit
 * 21:27–21:28 Asia/Dhaka and manual close 23:13, both MEXC 2001 "order direction error").
 *
 *   npm run ops:close-incident-trace -- --symbol XAU_USDT --from 2026-11-14T15:20:00Z --to 2026-11-14T17:20:00Z
 *   npm run ops:close-incident-trace -- --symbol XAU_USDT --oid fb99f029e66f4f43906d20ce2b7a3798
 *   (Dhaka = UTC+6; --days N widens the MEXC fill history, default 3)
 *
 * Database: one READ ONLY transaction. MEXC: the READ_ONLY transport (allowlisted GETs only; it
 * cannot send, change or cancel an order). Nothing is retried, replayed, booked or sent. API key,
 * secret and signatures are never printed.
 *
 * For each rejected close it prints the request as ACTUAL (stored on the intent by d3d52dd and
 * later) or RECONSTRUCTED (earlier revisions: rebuilt from the stored inputs and that revision's
 * rules, labelled as such), the MEXC answer, the account mode / position / margin mode / closable
 * quantity MEXC reports now, the field-by-field comparison with the current builder, and the side
 * codes MEXC itself recorded for closes that DID fill on this symbol (e.g. a close on the website),
 * which is the evidence for or against the documented close sides in this account's mode.
 */
import { sql } from 'drizzle-orm';
import { Decimal } from '@trendpilot/domain';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { connectionFor } from '../live/liveMode';
import { mexcReadOnly } from '../live/liveSync';
import { MEXC_PRIVATE_DEFAULT_BASE_URL, normalizePositions } from '../live/mexcPrivate';
import { buildMexcCloseOrder, MEXC_ORDER_CREATE_PATH } from '../live/mexcVenue';

loadRootEnv();
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const symbol = (arg('symbol') ?? 'XAU_USDT').toUpperCase();
const oids = (arg('oid') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const from = new Date(arg('from') ?? '2026-11-14T15:20:00Z');
const to = new Date(arg('to') ?? '2026-11-14T17:20:00Z');
const days = Number(arg('days') ?? 3);
const D = (v: Decimal.Value) => new Decimal(v);
type Row = Record<string, unknown>;
const print = (title: string, rows: unknown[] | Record<string, unknown>) => {
  const list = Array.isArray(rows) ? rows : [rows];
  console.log(`\n## ${title} (${list.length})`);
  if (list.length) console.table(list);
};
const json = (title: string, v: unknown) => console.log(`\n## ${title}\n${JSON.stringify(v, null, 2)}`);
const SIDE: Record<number, string> = { 1: '1 open long / buy', 2: '2 close short', 3: '3 open short / sell', 4: '4 close long' };

const baseUrl = process.env.MEXC_PRIVATE_BASE_URL || MEXC_PRIVATE_DEFAULT_BASE_URL;
console.log(`Close incident trace · ${symbol} · ${oids.length ? `externalOid ${oids.join(', ')}` : `${from.toISOString()} → ${to.toISOString()}`} · read-only`);
console.log(`Order endpoint used by the Live adapter: POST ${baseUrl.replace(/\/+$/, '')}${MEXC_ORDER_CREATE_PATH} (JSON body, signed headers redacted)`);

const h = createDb(requireEnv('DATABASE_URL'), 1);
let intents: Row[] = [];
const positionsById = new Map<string, Row>();
const connMode = new Map<string, string | null>();
try {
  await h.db.transaction(
    async (tx) => {
      const q = async (s: ReturnType<typeof sql>) => (await tx.execute(s)).rows as Row[];
      print(
        'Running worker(s): revision reported by the heartbeat (none = started before d3d52dd)',
        await q(sql`SELECT instance, started_at, last_seen_at, stopped_at, coalesce(detail->>'revision', '(not reported)') AS revision, detail->>'pid' AS pid FROM service_heartbeats WHERE service = 'worker' ORDER BY last_seen_at DESC LIMIT 5`)
      );
      print('Applied migrations (0026 = d3d52dd)', await q(sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 3`).catch(() => []));
      intents = await q(sql`
        SELECT o.id, u.email, o.owner_id, o.position_id, o.exit_reason, o.side AS position_side, o.state, o.state_reason,
               o.client_order_id, length(o.client_order_id) AS oid_len, o.contracts, o.filled_contracts, o.margin_mode,
               o.created_at, o.submitted_at, o.resolved_at, o.venue_request, o.venue_response
        FROM order_intents o JOIN users u ON u.id = o.owner_id JOIN instruments i ON i.id = o.instrument_id
        WHERE o.kind = 'CLOSE' AND o.mode = 'LIVE' AND upper(i.exchange_symbol) = ${symbol}
          AND ${
            oids.length
              ? sql`o.client_order_id IN (${sql.join(
                  oids.map((x) => sql`${x}`),
                  sql`, `
                )})`
              : sql`o.created_at BETWEEN ${from.toISOString()}::timestamptz AND ${to.toISOString()}::timestamptz`
          }
        ORDER BY o.created_at`);
      print(
        'Live CLOSE intents',
        intents.map(({ venue_request: _r, venue_response: _s, owner_id: _o, ...rest }) => rest)
      );
      if (!intents.length) return;
      const ids = sql.join(
        intents.map((i) => sql`${i.id}`),
        sql`, `
      );
      print('Jobs for these intents', await q(sql`SELECT payload->>'intentId' AS intent_id, kind, status, attempts, left(last_error, 160) AS last_error, created_at, completed_at FROM jobs WHERE payload->>'intentId' IN (${ids}) ORDER BY created_at`));
      for (const pid of new Set(intents.map((i) => String(i.position_id)))) {
        const [p] = await q(sql`
          SELECT p.id, p.owner_id, p.side, p.status, p.contracts, p.initial_contracts, p.avg_entry_price, p.margin_mode, p.leverage,
                 p.stop_price, p.stop_order_ref, p.stop_contracts, p.protection_status, p.exchange_position_ref, p.exchange_contracts, p.exchange_synced_at,
                 p.trailing_status, p.trailing_stop_price, p.trailing_planned_contracts, p.trailing_filled_contracts,
                 p.exit_halted_at, p.exit_halt_reason, p.opened_at, p.closed_at, p.close_reason
          FROM positions p WHERE p.id = ${pid}::uuid`);
        if (p) positionsById.set(pid, p);
      }
      print('Positions (TrendPilot)', [...positionsById.values()]);
      for (const o of new Set(intents.map((i) => String(i.owner_id)))) {
        const [c] = await q(sql`SELECT owner_id, status, position_mode, entries_halted, halt_reason, last_sync_at, left(last_sync_error, 160) AS last_sync_error FROM exchange_connections WHERE owner_id = ${o}::uuid`);
        connMode.set(o, (c?.position_mode as string | null) ?? null);
        print(`Stored exchange connection for owner ${o} (keys never printed)`, c ? c : []);
      }
    },
    { accessMode: 'read only' }
  );
} finally {
  await h.close();
}
if (!intents.length) {
  console.log('\nNo matching Live CLOSE intents.');
  process.exit(0);
}

const h2 = createDb(requireEnv('DATABASE_URL'), 1);
try {
  for (const ownerId of new Set(intents.map((i) => String(i.owner_id)))) {
    const conn = await connectionFor(h2.db, ownerId);
    if (!conn) continue;
    const read = mexcReadOnly(conn); // READ_ONLY transport: allowlisted GET queries only
    console.log(`\n# MEXC now (read-only) for owner ${ownerId}`);
    const modeRaw = await read.positionMode().catch((e: Error) => `error: ${e.message}`);
    const accountMode = Number(modeRaw) === 2 ? 'ONE_WAY' : Number(modeRaw) === 1 ? 'HEDGE' : null;
    print('Account position mode (1 hedge, 2 one-way)', { raw: String(modeRaw), accountMode, storedInTrendPilot: connMode.get(ownerId) ?? null });
    const rawPositions = (await read.rawOpenPositions().catch(() => [] as Row[])).filter((p) => String(p.symbol).toUpperCase() === symbol);
    print(
      `Raw MEXC open positions on ${symbol} (positionType 1 long / 2 short; openType 1 isolated / 2 cross; closable = holdVol − frozenVol)`,
      rawPositions.map((p) => ({ positionId: p.positionId, positionType: p.positionType, openType: p.openType, state: p.state, holdVol: p.holdVol, frozenVol: p.frozenVol, closable: D(String(p.holdVol ?? 0)).minus(String(p.frozenVol ?? 0)).toFixed(), leverage: p.leverage, holdAvgPrice: p.holdAvgPrice, liquidatePrice: p.liquidatePrice }))
    );
    const venuePositions = normalizePositions(rawPositions).filter((p) => p.open && D(p.contracts).gt(0));
    print(`MEXC stop orders on ${symbol}`, (await read.stops(symbol).catch(() => [])).map((s) => ({ ...s })));

    // What MEXC itself recorded for closes that filled: the side codes this account's mode uses.
    const deals = await read.deals(symbol, Date.now() - days * 86_400_000).catch((e: Error) => {
      console.log(`deal history failed: ${e.message}`);
      return [];
    });
    print(
      `MEXC fills on ${symbol}, last ${days} day(s) (side as MEXC recorded it)`,
      deals.map((d) => ({ time: new Date(d.timestamp).toISOString(), orderId: d.orderId, side: SIDE[d.side] ?? d.side, vol: d.vol, price: d.price, profit: d.profit, positionId: d.positionId }))
    );
    const orderIds = [...new Set(deals.map((d) => d.orderId))].slice(-20);
    const rawOrders: Row[] = [];
    for (const id of orderIds) {
      const o = await read.rawOrder(id).catch(() => null);
      if (o) rawOrders.push(o);
    }
    print(
      'Raw MEXC orders behind those fills (reduce-only, position mode and external ID as MEXC lists them)',
      rawOrders.map((o) => ({ orderId: o.orderId, externalOid: o.externalOid, side: SIDE[Number(o.side)] ?? o.side, orderType: o.orderType, openType: o.openType, positionMode: o.positionMode, reduceOnly: o.reduceOnly, positionId: o.positionId, vol: o.vol, dealVol: o.dealVol, state: o.state, category: o.category, createTime: o.createTime ? new Date(Number(o.createTime)).toISOString() : null }))
    );

    for (const i of intents.filter((x) => String(x.owner_id) === ownerId)) {
      const p = positionsById.get(String(i.position_id));
      const side = String(i.position_side) as 'LONG' | 'SHORT';
      console.log(`\n# ${i.exit_reason} ${i.client_order_id} (${new Date(String(i.created_at)).toISOString()}) → ${i.state} ${i.state_reason ?? ''}`);
      let looked: unknown;
      try {
        looked = (await read.orderByClientId(symbol, String(i.client_order_id))) ?? 'no such order at MEXC (rejected at create)';
      } catch (e) {
        looked = `lookup failed: ${(e as Error).message}`;
      }
      print('MEXC lookup by externalOid', typeof looked === 'string' ? { result: looked } : (looked as Row));

      let sent: Row;
      if (i.venue_request) {
        sent = ((i.venue_request as Row).body ?? {}) as Row;
        json('ACTUAL request (stored by the deployed revision)', i.venue_request);
        json('ACTUAL MEXC response (code, message)', i.venue_response);
      } else {
        // Revisions before d3d52dd did not keep the request: rebuilt from the stored inputs.
        const vp = venuePositions.find((v) => v.side === side);
        const stored = connMode.get(ownerId) ?? 'ONE_WAY';
        sent = {
          symbol,
          price: side === 'LONG' ? '<bid at send>' : '<ask at send>',
          vol: D(String(i.contracts)).toFixed(),
          side: side === 'LONG' ? 4 : 2,
          type: 5,
          openType: i.margin_mode === 'CROSS' ? 2 : 1,
          externalOid: i.client_order_id,
          positionId: vp ? Number(vp.positionId) : '<MEXC position on that side at send>',
          ...(stored === 'ONE_WAY' ? { reduceOnly: true } : {}),
          positionMode: stored === 'HEDGE' ? 1 : 2
        };
        json('RECONSTRUCTED request (pre-d3d52dd rules: openType from TrendPilot, mode from the stored connection; vol before the MEXC cap)', sent);
        console.log(`MEXC response as recorded: ${i.state_reason} (message not retained before d3d52dd)`);
      }
      const vp = (p?.exchange_position_ref ? venuePositions.find((v) => v.positionId === p.exchange_position_ref) : undefined) ?? venuePositions.find((v) => v.side === side);
      if (!vp || !accountMode) {
        console.log(vp ? 'Account mode could not be read.' : `MEXC holds no open ${side} on ${symbol} now: the current builder would send nothing.`);
        continue;
      }
      const now = buildMexcCloseOrder({ symbol, clientOrderId: String(i.client_order_id), positionSide: side, accountMode, exchangePosition: vp, contracts: String(i.contracts), qtyStep: '1', quote: { bid: '0', ask: '0' } });
      const cur = now.ok ? now.body : {};
      const fields = ['symbol', 'side', 'type', 'vol', 'openType', 'positionId', 'reduceOnly', 'positionMode', 'externalOid'];
      print(
        'Sent vs. MEXC now vs. current builder',
        fields.map((f) => ({ field: f, sent: JSON.stringify(sent[f]), currentBuilder: JSON.stringify(cur[f]), same: JSON.stringify(sent[f]) === JSON.stringify(cur[f]) }))
      );
      print('MEXC position matched', { positionId: vp.positionId, side: vp.side, holdVol: vp.contracts, frozenVol: vp.frozen, marginMode: vp.marginMode, accountMode, trendpilotContracts: p?.contracts, intentContracts: i.contracts });
    }
  }
} finally {
  await h2.close();
}
