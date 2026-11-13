/**
 * Read-only trace of one TradingView alert: event → routing decision per order block (block ID,
 * revision and mode saved at evaluation) → entry decision → order intent (mode, state, client
 * order ID) → durable jobs → fills (a Live MEXC order ID appears as `mexc:<orderId>`). Also lists
 * every DEAD `paper.submit` job with the alert and mode its intent belongs to. Note: Paper and
 * Live entries share the `paper.submit` job kind; the intent's mode decides the venue.
 *
 * Everything runs in one READ ONLY transaction: the database refuses any write. Nothing is
 * replayed, retried or sent.
 *
 *   npm run ops:alert-trace -- --symbol XAU_USDT --action BEARISH_FLIP --at 2026-11-13T16:50:00+06:00 [--minutes 20] [--email investor@…]
 */
import { sql } from 'drizzle-orm';
import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';

loadRootEnv();
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const symbol = (arg('symbol') ?? 'XAU_USDT').toUpperCase();
const action = arg('action') ?? 'BEARISH_FLIP';
const at = new Date(arg('at') ?? '');
if (Number.isNaN(at.getTime())) {
  console.error('Give --at as an ISO time with offset, e.g. 2026-11-13T16:50:00+06:00');
  process.exit(2);
}
const minutes = Number(arg('minutes') ?? '20');
const email = arg('email') ?? null;
const from = new Date(at.getTime() - minutes * 60_000);
const to = new Date(at.getTime() + minutes * 60_000);

const h = createDb(requireEnv('DATABASE_URL'), 1);
const print = (title: string, rows: unknown[]) => {
  console.log(`\n## ${title} (${rows.length})`);
  if (rows.length) console.table(rows);
};

try {
  await h.db.transaction(
    async (tx) => {
      const q = async (s: ReturnType<typeof sql>) => (await tx.execute(s)).rows;

      const events = await q(sql`
        SELECT e.id, e.action, e.source_exchange || ':' || e.source_symbol AS source, e.interval, e.bar_close_at, e.received_at, e.reference_price,
               e.disposition, e.status, e.dispatched_at, e.correlation_id, i.symbol, i.exchange_symbol
        FROM signal_events e JOIN instruments i ON i.id = e.instrument_id
        WHERE (upper(i.exchange_symbol) = ${symbol} OR upper(i.symbol) = ${symbol.replace('_', '')} OR upper(i.symbol) = ${symbol})
          AND e.action = ${action} AND (e.received_at BETWEEN ${from} AND ${to} OR e.bar_close_at BETWEEN ${from} AND ${to})
        ORDER BY e.received_at`);
      print(`Events ${action} ${symbol} between ${from.toISOString()} and ${to.toISOString()}`, events);
      const ids = events.map((e) => e.id as string);

      if (ids.length) {
        const idList = sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
        const owner = email ? sql`AND u.email = ${email}` : sql``;
        print(
          'Decisions per order block (mode and revision as saved at evaluation; current mode for comparison)',
          await q(sql`
            SELECT d.event_id, u.email, d.order_block_id, d.step, d.status, d.reason, d.detail->>'mode' AS mode_at_eval, d.detail->>'blockRevision' AS block_rev_at_eval,
                   b.mode AS block_mode_now, b.revision AS block_rev_now, b.status AS block_status_now, d.detail->>'side' AS side, d.detail->>'reasonText' AS reason_text,
                   d.detail->'liveBlockers' AS live_blockers, d.evaluated_at
            FROM signal_decisions d JOIN users u ON u.id = d.owner_id JOIN order_blocks b ON b.id = d.order_block_id
            WHERE d.event_id IN (${idList}) ${owner}
            ORDER BY u.email, d.order_block_id, d.step`)
        );
        const intents = await q(sql`
          SELECT o.id, o.event_id, u.email, o.order_block_id, o.mode, o.kind, o.side, o.state, o.state_reason, o.client_order_id, o.contracts, o.expected_price, o.leverage,
                 o.reserved_usdt, o.submitted_at, o.resolved_at, a.mode AS account_mode
          FROM order_intents o JOIN users u ON u.id = o.owner_id JOIN paper_accounts a ON a.id = o.paper_account_id
          WHERE o.event_id IN (${idList}) ${owner}
          ORDER BY o.created_at`);
        print('Order intents created for these events', intents);
        print(
          'Jobs for these events and intents',
          await q(sql`
            SELECT j.id, j.kind, j.status, j.attempts, j.max_attempts, j.payload, left(j.last_error, 240) AS last_error, j.created_at, j.completed_at
            FROM jobs j
            WHERE j.payload->>'eventId' IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
               OR j.payload->>'intentId' IN (SELECT o.id::text FROM order_intents o WHERE o.event_id IN (${idList}))
            ORDER BY j.created_at`)
        );
        print(
          'Fills for these intents (Live MEXC order IDs appear as mexc:<orderId>)',
          await q(sql`
            SELECT f.intent_id, f.exchange_fill_id, f.side, f.contracts, f.price, f.filled_at
            FROM fills f WHERE f.intent_id IN (SELECT o.id FROM order_intents o WHERE o.event_id IN (${idList}))`)
        );
      }

      print(
        'All DEAD paper.submit jobs, with the alert and mode of their intent',
        await q(sql`
          SELECT j.id AS job_id, j.attempts, j.max_attempts, left(j.last_error, 240) AS last_error, j.created_at, j.updated_at,
                 o.id AS intent_id, o.mode, o.state, o.state_reason, o.client_order_id, u.email, o.order_block_id,
                 e.id AS event_id, e.action, i.exchange_symbol, e.bar_close_at, e.received_at
          FROM jobs j
          LEFT JOIN order_intents o ON o.id::text = j.payload->>'intentId'
          LEFT JOIN users u ON u.id = o.owner_id
          LEFT JOIN signal_events e ON e.id = o.event_id
          LEFT JOIN instruments i ON i.id = o.instrument_id
          WHERE j.kind = 'paper.submit' AND j.status = 'DEAD'
          ORDER BY j.created_at`)
      );
    },
    { accessMode: 'read only' }
  );
} finally {
  await h.close();
}
