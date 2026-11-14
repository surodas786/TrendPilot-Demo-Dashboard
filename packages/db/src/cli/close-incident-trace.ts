/**
 * Read-only trace of rejected Live CLOSE orders (incident 14 Nov 2026, XAU_USDT trailing take
 * profit, MEXC 2001 "order direction error").
 *
 *   npm run ops:close-incident-trace -- --symbol XAU_USDT --from 2026-11-14T15:20:00Z --to 2026-11-14T15:40:00Z
 *   (21:27–21:28 Asia/Dhaka = 15:27–15:28 UTC)
 *
 * Database: one READ ONLY transaction. MEXC: the READ_ONLY transport (allowlisted GETs only; it
 * cannot send, change or cancel an order). Nothing is retried, replayed, booked or sent.
 *
 * Prints, per affected investor: the rejected close intents (client order ID, length, state,
 * reason, stored request/response where recorded), their jobs, the position (side, margin mode,
 * MEXC position ID, trailing state, exit halt), the stored connection mode, worker heartbeats with
 * the revision they report, then from MEXC: the account position mode, the raw open positions on
 * the symbol (positionType, openType, holdVol, frozenVol, positionId), the stop orders, and each
 * externalOid looked up. Finally it serializes the request the incident-time code would have sent
 * next to what `buildMexcCloseOrder` sends now, and lists every field that differs.
 * API key, secret and signatures are never printed.
 */
import { sql } from 'drizzle-orm';
import { Decimal } from '@trendpilot/domain';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { connectionFor } from '../live/liveMode';
import { mexcReadOnly } from '../live/liveSync';
import { normalizePositions } from '../live/mexcPrivate';
import { buildMexcCloseOrder } from '../live/mexcVenue';

loadRootEnv();
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const symbol = (arg('symbol') ?? 'XAU_USDT').toUpperCase();
const from = new Date(arg('from') ?? '2026-11-14T15:20:00Z');
const to = new Date(arg('to') ?? '2026-11-14T15:40:00Z');
const D = (v: Decimal.Value) => new Decimal(v);
type Row = Record<string, unknown>;
const print = (title: string, rows: unknown[] | Record<string, unknown>) => {
  const list = Array.isArray(rows) ? rows : [rows];
  console.log(`\n## ${title} (${list.length})`);
  if (list.length) console.table(list);
};
const json = (title: string, v: unknown) => console.log(`\n## ${title}\n${JSON.stringify(v, null, 2)}`);

console.log(`Close incident trace · ${symbol} · ${from.toISOString()} → ${to.toISOString()} · read-only`);

const h = createDb(requireEnv('DATABASE_URL'), 1);
let intents: Row[] = [];
const positionsById = new Map<string, Row>();
const connMode = new Map<string, string | null>();
try {
  await h.db.transaction(
    async (tx) => {
      const q = async (s: ReturnType<typeof sql>) => (await tx.execute(s)).rows as Row[];
      intents = await q(sql`
        SELECT o.id, u.email, o.owner_id, o.position_id, o.exit_reason, o.side AS position_side, o.state, o.state_reason,
               o.client_order_id, length(o.client_order_id) AS oid_len, o.contracts, o.filled_contracts, o.margin_mode,
               o.created_at, o.submitted_at, o.resolved_at, o.venue_request, o.venue_response
        FROM order_intents o JOIN users u ON u.id = o.owner_id JOIN instruments i ON i.id = o.instrument_id
        WHERE o.kind = 'CLOSE' AND o.mode = 'LIVE' AND upper(i.exchange_symbol) = ${symbol}
          AND o.created_at BETWEEN ${from.toISOString()}::timestamptz AND ${to.toISOString()}::timestamptz
        ORDER BY o.created_at`);
      print(
        'Live CLOSE intents in the window',
        intents.map(({ venue_request: _r, venue_response: _s, owner_id: _o, ...rest }) => rest)
      );
      for (const i of intents.filter((x) => x.venue_request || x.venue_response)) json(`Stored request/response for ${i.client_order_id}`, { request: i.venue_request, response: i.venue_response });
      if (!intents.length) return;
      const ids = sql.join(intents.map((i) => sql`${i.id}`), sql`, `);
      print('Jobs for these intents', await q(sql`SELECT payload->>'intentId' AS intent_id, kind, status, attempts, left(last_error, 160) AS last_error, created_at, completed_at FROM jobs WHERE payload->>'intentId' IN (${ids}) ORDER BY created_at`));
      const posIds = [...new Set(intents.map((i) => String(i.position_id)))];
      for (const pid of posIds) {
        const [p] = await q(sql`
          SELECT p.id, p.owner_id, p.paper_account_id, p.side, p.status, p.contracts, p.initial_contracts, p.avg_entry_price, p.margin_mode, p.leverage,
                 p.stop_price, p.stop_order_ref, p.stop_contracts, p.protection_status, p.exchange_position_ref, p.exchange_contracts, p.exchange_synced_at,
                 p.trailing_status, p.trailing_kind, p.trailing_basis, p.trailing_stop_price, p.trailing_watermark, p.trailing_planned_contracts, p.trailing_filled_contracts,
                 p.exit_halted_at, p.exit_halt_reason, p.opened_at, p.closed_at, p.close_reason
          FROM positions p WHERE p.id = ${pid}::uuid`);
        if (p) positionsById.set(pid, p);
      }
      print('Positions (TrendPilot)', [...positionsById.values()]);
      const owners = [...new Set(intents.map((i) => String(i.owner_id)))];
      for (const o of owners) {
        const [c] = await q(sql`SELECT owner_id, status, position_mode, entries_halted, halt_reason, last_sync_at, left(last_sync_error, 160) AS last_sync_error FROM exchange_connections WHERE owner_id = ${o}::uuid`);
        connMode.set(o, (c?.position_mode as string | null) ?? null);
        print(`Stored exchange connection for owner ${o} (keys never printed)`, c ? c : []);
      }
      print(
        'Worker heartbeats (revision is reported from this release on; older workers show none)',
        await q(sql`SELECT instance, started_at, last_seen_at, stopped_at, detail->>'revision' AS revision, detail->>'pid' AS pid FROM service_heartbeats WHERE service = 'worker' ORDER BY last_seen_at DESC LIMIT 5`)
      );
    },
    { accessMode: 'read only' }
  );
} finally {
  await h.close();
}
if (!intents.length) {
  console.log('\nNo Live CLOSE intents in that window.');
  process.exit(0);
}

const h2 = createDb(requireEnv('DATABASE_URL'), 1);
try {
  for (const ownerId of new Set(intents.map((i) => String(i.owner_id)))) {
    const conn = await connectionFor(h2.db, ownerId);
    if (!conn) continue;
    const read = mexcReadOnly(conn); // READ_ONLY transport: allowlisted GET queries only
    console.log(`\n# MEXC (read-only) for owner ${ownerId}`);
    const modeRaw = await read.positionMode().catch((e: Error) => `error: ${e.message}`);
    const accountMode = Number(modeRaw) === 2 ? 'ONE_WAY' : Number(modeRaw) === 1 ? 'HEDGE' : null;
    print('Account position mode (1 hedge, 2 one-way)', { raw: String(modeRaw), accountMode, stored: connMode.get(ownerId) ?? null });
    const rawPositions = (await read.rawOpenPositions().catch(() => [] as Row[])).filter((p) => String(p.symbol).toUpperCase() === symbol);
    print(
      `Raw MEXC open positions on ${symbol} (positionType 1 long / 2 short; openType 1 isolated / 2 cross)`,
      rawPositions.map((p) => ({ positionId: p.positionId, positionType: p.positionType, openType: p.openType, state: p.state, holdVol: p.holdVol, frozenVol: p.frozenVol, closeVol: p.closeVol, leverage: p.leverage, holdAvgPrice: p.holdAvgPrice, liquidatePrice: p.liquidatePrice }))
    );
    const venuePositions = normalizePositions(rawPositions).filter((p) => p.open && D(p.contracts).gt(0));
    const stops = await read.stops(symbol).catch(() => []);
    print(`MEXC stop orders on ${symbol}`, stops.map((s) => ({ ...s })));

    for (const i of intents.filter((x) => String(x.owner_id) === ownerId)) {
      let looked: unknown;
      try {
        looked = (await read.orderByClientId(symbol, String(i.client_order_id))) ?? 'no such order at MEXC';
      } catch (e) {
        looked = `lookup failed: ${(e as Error).message}`;
      }
      print(`MEXC lookup of externalOid ${i.client_order_id}`, typeof looked === 'string' ? { result: looked } : (looked as Row));
    }

    // Serialized requests: incident-time code vs. the current builder, per position.
    for (const p of [...positionsById.values()].filter((x) => String(x.owner_id) === ownerId)) {
      const side = String(p.side) as 'LONG' | 'SHORT';
      const sample = intents.filter((x) => x.position_id === p.id).at(-1)!;
      const vp = (p.exchange_position_ref ? venuePositions.find((v) => v.positionId === p.exchange_position_ref) : undefined) ?? venuePositions.find((v) => v.side === side);
      const storedMode = connMode.get(ownerId) ?? 'ONE_WAY';
      const contracts = vp ? Decimal.min(String(sample.contracts), vp.contracts).toFixed() : String(sample.contracts);
      const before = {
        symbol,
        price: '<ask/bid at the time>',
        vol: contracts,
        side: side === 'LONG' ? 4 : 2,
        type: 5,
        openType: p.margin_mode === 'CROSS' ? 2 : 1, // from TrendPilot's stored margin mode
        externalOid: sample.client_order_id,
        positionId: vp ? Number(vp.positionId) : undefined, // first MEXC position on that side
        ...(storedMode === 'ONE_WAY' ? { reduceOnly: true } : {}), // from the stored connection mode
        positionMode: storedMode === 'HEDGE' ? 1 : 2
      };
      json(`Request the incident-time code serialized for position ${p.id} (reconstructed; MEXC order create)`, before);
      if (!vp || !accountMode) {
        console.log(vp ? 'Account mode could not be read.' : `MEXC holds no open ${side} on ${symbol} now: the current builder would send nothing (REDUCE_ONLY_NO_POSITION).`);
        continue;
      }
      const now = buildMexcCloseOrder({ symbol, clientOrderId: String(sample.client_order_id), positionSide: side, accountMode, exchangePosition: vp, contracts: String(sample.contracts), qtyStep: '1', quote: { bid: '0', ask: '0' } });
      json('Request the current builder serializes (price omitted here)', now.ok ? { ...now.body, price: '<ask/bid at send time>' } : now);
      if (now.ok) {
        const diff = Object.keys({ ...before, ...now.body })
          .filter((k) => k !== 'price')
          .filter((k) => JSON.stringify((before as Row)[k]) !== JSON.stringify(now.body[k]))
          .map((k) => ({ field: k, incident: JSON.stringify((before as Row)[k]), now: JSON.stringify(now.body[k]) }));
        print('Fields that differ (empty = identical; then the cause is outside the mapping → ask MEXC support)', diff);
      }
      print('Closable quantity', { trendpilot: p.contracts, mexcHoldVol: vp.contracts, mexcFrozenVol: vp.frozen, intentContracts: sample.contracts, mexcMarginMode: vp.marginMode, trendpilotMarginMode: p.margin_mode });
    }
  }
} finally {
  await h2.close();
}
