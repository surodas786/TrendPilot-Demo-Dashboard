/**
 * Read-only Lighter release readiness for the production server. Prints, without secrets:
 *  - the checked-out revision and any migration not yet applied;
 *  - the Lighter Live settings (order switches, scope lists, price bounds, fee, sync) as configured;
 *  - the Lighter capability records;
 *  - every published contract's own feed (exchange, quote source, age);
 *  - every Lighter connection (status, environment, account index, approval, activation, halt,
 *    last sync, drift) and its Lighter Live scope verdict;
 *  - every TradingView route with a Lighter target, its most recent REAL alerts, the routing
 *    decisions recorded for Lighter blocks, and the per-block Lighter Live scope verdict for an alert.
 *
 * One READ ONLY transaction: the database refuses any write. Nothing is sent to Lighter, no alert
 * is created or replayed, no job is queued. API keys, sealed secrets and signatures are never read.
 *
 *   npm run ops:lighter-readiness [-- --events 5]
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createDb } from '../client';
import { findRepoRoot, loadRootEnv, requireEnv } from '../env';
import { lighterLiveInputs } from '../live/lighterConnection';
import { lighterLiveRefusalFor } from '../live/liveMode';
import { lighterLiveScope, lighterMainnetOrdersEnabled } from '../live/lighterLiveScope';

loadRootEnv();
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const eventsPerRoute = Math.min(Math.max(Number(arg('events') ?? '5') || 5, 1), 50);
const env = process.env;
const print = (title: string, rows: unknown[]) => {
  console.log(`\n## ${title} (${rows.length})`);
  if (rows.length) console.table(rows);
};
const ageS = (t: unknown) => (t ? Math.round((Date.now() - new Date(t as string).getTime()) / 1000) : null);

const root = findRepoRoot();
let revision = 'unknown';
try {
  revision = execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  /* not a git checkout */
}
console.log(`# Lighter readiness — ${new Date().toISOString()}\nrevision: ${revision}`);

const h = createDb(requireEnv('DATABASE_URL'), 1);
try {
  await h.db.transaction(
    async (tx) => {
      const q = async (s: ReturnType<typeof sql>) => (await tx.execute(s)).rows as Record<string, unknown>[];

      // Migrations: drizzle records each applied migration's journal `when` as created_at.
      const journal = JSON.parse(readFileSync(path.join(root, 'packages/db/migrations/meta/_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] };
      let applied: number[] = [];
      try {
        applied = (await q(sql`SELECT created_at FROM drizzle.__drizzle_migrations`)).map((r) => Number(r.created_at));
      } catch {
        console.log('migrations: drizzle.__drizzle_migrations not readable');
      }
      const pending = journal.entries.filter((e) => !applied.includes(e.when)).map((e) => e.tag);
      console.log(`migrations: ${journal.entries.length} in repo, ${applied.length} applied, pending: ${pending.length ? pending.join(', ') : 'none'}`);
      if (pending.length) {
        console.log('Apply the pending migrations first (npm run db:migrate), then run this again.');
        process.exitCode = 1;
        return;
      }

      const scope = lighterLiveScope(env);
      const inputs = lighterLiveInputs(env);
      const show = (k: string) => (env[k] === undefined || env[k] === '' ? '(unset)' : env[k]!);
      print('Lighter Live settings (server .env, no secrets)', [
        { setting: 'LIVE_ORDER_TRANSPORT', value: show('LIVE_ORDER_TRANSPORT') },
        { setting: 'LIGHTER_MAINNET_ORDERS', value: show('LIGHTER_MAINNET_ORDERS'), effective: lighterMainnetOrdersEnabled(env) ? 'ORDERS ENABLED' : 'orders disabled' },
        { setting: 'LIGHTER_LIVE_CONNECTIONS', value: [...scope.connections].join(',') || '(none)' },
        { setting: 'LIGHTER_LIVE_MARKETS', value: [...scope.markets].join(',') || '(none)' },
        { setting: 'LIGHTER_LIVE_ROUTES', value: [...scope.routes].join(',') || '(none)' },
        { setting: 'LIGHTER_ENTRY_WORST_PRICE_PCT', value: show('LIGHTER_ENTRY_WORST_PRICE_PCT'), effective: inputs.entryWorstPricePct ?? 'INVALID/UNSET' },
        { setting: 'LIGHTER_STOP_WORST_PRICE_PCT', value: show('LIGHTER_STOP_WORST_PRICE_PCT'), effective: inputs.stopWorstPricePct ?? 'INVALID/UNSET' },
        { setting: 'LIGHTER_CLOSE_WORST_PRICE_PCT', value: show('LIGHTER_CLOSE_WORST_PRICE_PCT'), effective: inputs.closeWorstPricePct ?? 'INVALID/UNSET' },
        { setting: 'LIGHTER_TAKER_FEE_RATE', value: show('LIGHTER_TAKER_FEE_RATE'), effective: inputs.takerFeeRate ?? 'INVALID/UNSET' },
        { setting: 'LIGHTER_STOP_RENEW_LEAD_HOURS', value: show('LIGHTER_STOP_RENEW_LEAD_HOURS') },
        { setting: 'LIGHTER_PRIVATE_SYNC', value: show('LIGHTER_PRIVATE_SYNC') },
        { setting: 'LIGHTER_SYNC_MS', value: show('LIGHTER_SYNC_MS') },
        { setting: 'LIGHTER_PUBLIC_WS', value: show('LIGHTER_PUBLIC_WS') },
        { setting: 'LIGHTER_TESTNET', value: show('LIGHTER_TESTNET') }
      ]);
      if (scope.issues.length) console.log(`scope issues: ${scope.issues.join(' ')}`);

      const [control] = await q(sql`SELECT capability_evidence, live_enabled, entries_halted, halt_reason FROM live_control WHERE id = 1`);
      console.log(`\nplatform: liveEnabled=${control?.live_enabled ?? '?'} entriesHalted=${control?.entries_halted ?? '?'}${control?.halt_reason ? ` (${String(control.halt_reason).slice(0, 120)})` : ''}`);
      const ev = (control?.capability_evidence ?? {}) as Record<string, { state: string; evidence: string; at: string }>;
      print(
        'Lighter capability records',
        Object.entries(ev)
          .filter(([k]) => k.startsWith('LIGHTER_'))
          .map(([k, r]) => ({ capability: k, state: r.state, at: r.at, evidence: String(r.evidence).slice(0, 80) }))
      );

      const feeds = await q(sql`
        SELECT i.exchange, i.symbol, i.exchange_symbol, i.exchange_market_id AS market_id, i.live_allowed, q.source, q.as_of, q.bid, q.ask
        FROM instruments i
        LEFT JOIN LATERAL (SELECT source, as_of, bid, ask FROM market_quotes m WHERE m.instrument_id = i.id ORDER BY as_of DESC LIMIT 1) q ON true
        WHERE i.status = 'PUBLISHED'
        ORDER BY i.exchange, i.symbol`);
      print(
        'Published contracts and their own feed (source must be <EXCHANGE>_PUBLIC)',
        feeds.map((f) => ({ exchange: f.exchange, symbol: f.symbol, exchangeSymbol: f.exchange_symbol, marketId: f.market_id, liveAllowed: f.live_allowed, source: f.source ?? '(no quote)', ownFeed: f.source ? f.source === `${f.exchange}_PUBLIC` : false, ageSeconds: ageS(f.as_of), bid: f.bid, ask: f.ask }))
      );

      const conns = await q(sql`
        SELECT c.id, c.owner_id, u.email, c.status, c.venue_environment, c.venue_account_index, c.venue_api_key_index, c.approved_at IS NOT NULL AS approved, c.live_enabled, c.entries_halted, c.halt_reason,
               c.last_sync_at, c.last_sync_ok_at, c.last_sync_error, jsonb_array_length(coalesce(c.drift, '[]'::jsonb)) AS drift
        FROM exchange_connections c JOIN users u ON u.id = c.owner_id
        WHERE c.exchange = 'LIGHTER' AND c.status <> 'REVOKED' ORDER BY u.email`);
      const connRows = [];
      for (const c of conns) {
        connRows.push({
          connectionId: c.id,
          investor: c.email,
          status: c.status,
          env: c.venue_environment,
          accountIndex: c.venue_account_index,
          apiKeyIndex: c.venue_api_key_index,
          approved: c.approved,
          liveEnabled: c.live_enabled,
          halted: c.entries_halted ? String(c.halt_reason ?? 'yes').slice(0, 60) : false,
          lastSyncAgeS: ageS(c.last_sync_at),
          lastSyncOkAgeS: ageS(c.last_sync_ok_at),
          lastSyncError: c.last_sync_error ? String(c.last_sync_error).slice(0, 80) : null,
          drift: c.drift,
          scope: (await lighterLiveRefusalFor(tx, { ownerId: c.owner_id as string }, 'ACCOUNT', env)) ?? 'IN SCOPE'
        });
      }
      print('Lighter connections (no keys)', connRows);
      const txs = await q(sql`SELECT environment, purpose, state, count(*)::int AS n FROM lighter_txs GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
      print('Lighter transactions recorded by TrendPilot (exchange evidence source)', txs);

      const routes = await q(sql`
        SELECT r.id, r.name, r.source_exchange || ':' || r.source_symbol AS source, r.interval, r.action, r.kind, t.instrument_id, t.enabled AS target_enabled, i.exchange_symbol, i.exchange_market_id AS market_id,
               i.quote AS venue_ccy, pi.quote AS reference_ccy
        FROM signal_route_targets t JOIN signal_routes r ON r.id = t.route_id JOIN instruments i ON i.id = t.instrument_id LEFT JOIN instruments pi ON pi.id = r.instrument_id
        WHERE t.exchange = 'LIGHTER' ORDER BY r.name`);
      print(
        'TradingView routes with a Lighter target',
        routes.map((r) => ({ routeId: r.id, name: r.name, source: r.source, interval: r.interval, action: r.action, kind: r.kind, lighter: `${r.exchange_symbol} (market ${r.market_id})`, targetEnabled: r.target_enabled, routeInScope: scope.routes.has(String(r.id).toLowerCase()),
          // Same rule as the entry check (evaluatePaperEntry): a USDT reference against the USDC venue is compared 1:1 in PAPER only.
          liveComparison: r.reference_ccy === r.venue_ccy ? 'SAME_CURRENCY' : `UNAVAILABLE in Live (${r.reference_ccy ?? '?'} reference vs ${r.venue_ccy} venue: parity approved for Paper only)` }))
      );

      for (const r of routes) {
        const events = await q(sql`
          SELECT e.id, e.action, e.source_exchange || ':' || e.source_symbol AS source, e.interval, e.bar_close_at, e.received_at, e.reference_price, e.disposition, e.status,
                 ${r.instrument_id}::uuid = ANY(e.target_instrument_ids) AS targets_lighter
          FROM signal_events e WHERE e.route_id = ${r.id}::uuid ORDER BY e.received_at DESC LIMIT ${eventsPerRoute}`);
        print(`Recent real alerts on route ${r.name} (${r.id})`, events);
        const latest = events[0];
        if (latest) {
          print(
            `Decisions for Lighter blocks on the latest alert ${latest.id}`,
            await q(sql`
              SELECT u.email, b.mode, d.step, d.status, d.reason, left(coalesce(d.detail->>'reasonText', ''), 140) AS reason_text, d.evaluated_at
              FROM signal_decisions d JOIN order_blocks b ON b.id = d.order_block_id JOIN users u ON u.id = d.owner_id
              WHERE d.event_id = ${latest.id}::uuid AND b.instrument_id = ${r.instrument_id}::uuid ORDER BY u.email, d.step`)
          );
        }
        const blocks = await q(sql`
          SELECT b.id, b.owner_id, u.email, b.mode, b.status FROM order_blocks b JOIN users u ON u.id = b.owner_id
          WHERE b.instrument_id = ${r.instrument_id}::uuid AND b.mode = 'LIVE' ORDER BY u.email`);
        const verdicts = [];
        for (const b of blocks) {
          const scopeRefusal = await lighterLiveRefusalFor(tx, { ownerId: b.owner_id as string, instrumentId: r.instrument_id as string, routeId: r.id as string }, 'ENTRY', env);
          const comparison = r.reference_ccy === r.venue_ccy ? null : 'PRICE_COMPARISON_UNAVAILABLE: no Live rule for a USDT reference against the USDC Lighter price';
          verdicts.push({ investor: b.email, blockId: b.id, blockStatus: b.status, nextAlert: scopeRefusal ?? comparison ?? 'WOULD BE ELIGIBLE (other Live gates still apply)' });
        }
        print(`Lighter Live scope verdict for the next alert on ${r.name} (per Live block)`, verdicts);
      }
    },
    { accessMode: 'read only' }
  );
} finally {
  await h.close();
}
