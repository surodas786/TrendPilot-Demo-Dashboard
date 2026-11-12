// Release acceptance: READ-ONLY snapshot of a deployed TrendPilot database.
// Run on the server from the app directory:   npx tsx scripts/acceptance-check.ts [--since 2026-11-12T00:00:00Z]
// Every query runs inside a READ ONLY transaction. No keys, secrets, tokens or emails beyond the
// investors' own addresses are printed. Nothing is written, enqueued or sent.
import pg from 'pg';
import { loadRootEnv } from '@trendpilot/db';

loadRootEnv();
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set (run from the app directory with its .env).');
const sinceArg = process.argv.indexOf('--since');
const since = sinceArg > 0 ? process.argv[sinceArg + 1]! : new Date(Date.now() - 24 * 3600_000).toISOString();

const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query('BEGIN READ ONLY');
const q = async (title: string, sql: string, params: unknown[] = []) => {
  try {
    const r = await c.query(sql, params);
    console.log(`\n## ${title} (${r.rowCount})`);
    if (r.rows.length) console.table(r.rows);
  } catch (e) {
    console.log(`\n## ${title}: ERROR ${(e as Error).message}`);
    await c.query('ROLLBACK');
    await c.query('BEGIN READ ONLY');
  }
};

console.log(`TrendPilot acceptance snapshot ${new Date().toISOString()} · since ${since}`);
console.log(`LIVE_ORDER_TRANSPORT=${process.env.LIVE_ORDER_TRANSPORT ?? 'unset'} NODE_ENV=${process.env.NODE_ENV ?? 'unset'}`);
await q('Migrations applied (latest 3)', `SELECT id, hash, to_timestamp(created_at/1000) AS applied FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 3`);
await q('Live switch (must be Off)', `SELECT live_enabled, entries_halted, halt_reason, capability_evidence::text AS capabilities FROM live_control`);
await q('Exchange connections (no secrets)', `SELECT u.email, c.status, c.position_mode, c.approved_at IS NOT NULL AS approved, c.live_enabled, c.entries_halted FROM exchange_connections c JOIN users u ON u.id = c.owner_id`);
await q('Instruments', `SELECT symbol, exchange_symbol, status, is_fixture, live_allowed FROM instruments ORDER BY symbol`);
await q('Market feed per contract (quote_channel WS = WebSocket)', `SELECT i.symbol, f.state, f.quote_channel, f.last_quote_at, f.last_stream_at, f.consecutive_failures, left(f.last_error, 80) AS last_error FROM market_feed_status f JOIN instruments i ON i.id = f.instrument_id`);
await q('Quotes by channel since', `SELECT i.symbol, q.source, q.channel, count(*) AS quotes, max(q.as_of) AS newest FROM market_quotes q JOIN instruments i ON i.id = q.instrument_id WHERE q.as_of >= $1 GROUP BY 1,2,3 ORDER BY 1,3`, [since]);
await q('Feed service heartbeat (REST call counters)', `SELECT instance, last_seen_at, stopped_at, detail::text AS detail FROM service_heartbeats WHERE service = 'market-feed' ORDER BY last_seen_at DESC LIMIT 3`);
await q('Worker heartbeat', `SELECT instance, last_seen_at, stopped_at FROM service_heartbeats WHERE service = 'worker' ORDER BY last_seen_at DESC LIMIT 3`);
await q('Signal routes', `SELECT r.name, r.source_symbol, r.interval, r.action, r.enabled, i.symbol, p.name AS package FROM signal_routes r JOIN instruments i ON i.id = r.instrument_id LEFT JOIN strategy_packages p ON p.id = r.package_id ORDER BY r.interval, r.action`);
await q('Alerts since', `SELECT e.received_at, e.action, e.interval, e.bar_close_at, e.status, left(e.correlation_id, 12) AS corr FROM signal_events e WHERE e.received_at >= $1 ORDER BY e.received_at DESC LIMIT 20`, [since]);
await q('Rejected alerts since', `SELECT received_at, reason FROM signal_rejections WHERE received_at >= $1 ORDER BY received_at DESC LIMIT 10`, [since]);
await q('Decisions since (per investor)', `SELECT d.evaluated_at, u.email, b.mode, d.step, d.status, d.reason FROM signal_decisions d JOIN users u ON u.id = d.owner_id LEFT JOIN order_blocks b ON b.id = d.order_block_id WHERE d.evaluated_at >= $1 ORDER BY d.evaluated_at DESC LIMIT 40`, [since]);
await q('Order intents since', `SELECT o.created_at, u.email, o.mode, o.kind, o.side, o.state, o.state_reason, o.contracts, o.stop_price, o.exit_reason FROM order_intents o JOIN users u ON u.id = o.owner_id WHERE o.created_at >= $1 ORDER BY o.created_at DESC LIMIT 40`, [since]);
await q('Positions opened since', `SELECT p.opened_at, u.email, p.mode, i.symbol, p.side, p.status, p.initial_contracts, p.contracts, p.avg_entry_price, p.stop_price, p.stop_contracts, p.protection_status, p.close_reason, p.realized_pnl_usdt, p.fees_usdt FROM positions p JOIN users u ON u.id = p.owner_id JOIN instruments i ON i.id = p.instrument_id WHERE p.opened_at >= $1 ORDER BY p.opened_at DESC LIMIT 20`, [since]);
await q('Exit fills since', `SELECT x.filled_at, u.email, x.reason, x.contracts, x.price, x.fee, x.realized_pnl, x.remaining_contracts FROM position_exits x JOIN users u ON u.id = x.owner_id WHERE x.filled_at >= $1 ORDER BY x.filled_at DESC LIMIT 20`, [since]);
await q('Targets on positions opened since (arm then pullback)', `SELECT t.position_id, t.level_id, t.trigger_rule, t.trigger_price, t.planned_contracts, t.filled_contracts, t.status, t.armed_at, t.armed_price FROM position_targets t JOIN positions p ON p.id = t.position_id WHERE p.opened_at >= $1 ORDER BY t.position_id, t.ordinal`, [since]);
await q('Order blocks (investor settings summary)', `SELECT u.email, i.symbol, b.mode, b.status, b.weekdays::text, b.trading_window_start, b.trading_window_end, b.timezone, b.take_profit::text AS tp, b.trailing::text AS trailing FROM order_blocks b JOIN users u ON u.id = b.owner_id JOIN instruments i ON i.id = b.instrument_id ORDER BY u.email, i.symbol, b.mode`);
await q('Ledger reconciliation per account (wallet/margin/reserve = ledger)', `SELECT u.email, a.mode, a.wallet_balance, (SELECT coalesce(sum(amount),0) FROM ledger_entries l WHERE l.paper_account_id = a.id AND l.bucket='WALLET') AS ledger_wallet, a.position_margin, (SELECT coalesce(sum(amount),0) FROM ledger_entries l WHERE l.paper_account_id = a.id AND l.bucket='POSITION_MARGIN') AS ledger_margin, a.order_reserve, (SELECT coalesce(sum(amount),0) FROM ledger_entries l WHERE l.paper_account_id = a.id AND l.bucket='ORDER_RESERVE') AS ledger_reserve FROM paper_accounts a JOIN users u ON u.id = a.owner_id ORDER BY u.email, a.mode`);
await q('Jobs: dead or retrying', `SELECT kind, status, attempts, left(last_error, 100) AS last_error, updated_at FROM jobs WHERE status = 'DEAD' OR (status = 'PENDING' AND last_error IS NOT NULL) ORDER BY updated_at DESC LIMIT 10`);
await c.query('ROLLBACK');
await c.end();
