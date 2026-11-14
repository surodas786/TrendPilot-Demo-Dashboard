-- READ-ONLY trace of the XAU_USDT Live long (opened 13 Nov 2026 23:50 Asia/Dhaka, 1,540 contracts)
-- and the 14 Nov 00:50 bearish reversal, for one investor. READ ONLY transaction, ends with ROLLBACK.
-- Nothing is changed, retried, replayed or sent to MEXC. The 13 Nov 16:50 expired orders and their
-- DEAD jobs are only listed, never touched.
--
--   psql "$DATABASE_URL" -v email=surodas@proton.me -f scripts/ops/2026-11-14-xau-live-position-trace.sql
\set ON_ERROR_STOP on
\pset pager off
\x auto
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL TIME ZONE 'Asia/Dhaka';

SELECT id AS uid FROM users WHERE lower(email) = lower(:'email') \gset
SELECT p.id AS pid, p.paper_account_id AS acct, p.instrument_id AS inst, p.opened_at AS opened
FROM positions p JOIN instruments i ON i.id = p.instrument_id
WHERE p.owner_id = :'uid' AND upper(i.exchange_symbol) = 'XAU_USDT' AND p.mode = 'LIVE'
  AND p.opened_at BETWEEN '2026-11-13 23:30+06' AND '2026-11-14 00:10+06'
ORDER BY p.opened_at LIMIT 1 \gset

\echo '== Applied migrations (latest 3)'
SELECT id, hash, to_timestamp(created_at / 1000) AS applied_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 3;

\echo '== Connection: private sync status and drift'
SELECT c.account_ref, c.status, c.position_mode, c.live_enabled, c.entries_halted, c.halt_reason, c.halted_at,
       c.last_sync_at, c.last_sync_error, c.drift,
       (SELECT to_jsonb(c2) ->> 'last_sync_ok_at' FROM exchange_connections c2 WHERE c2.id = c.id) AS last_sync_ok_at_if_migrated
FROM exchange_connections c WHERE c.owner_id = :'uid';
\echo '== Platform switch and halt'
SELECT live_enabled, entries_halted, halt_reason, halted_at FROM live_control;

\echo '== The position (local view)'
SELECT id, side, status, contracts, initial_contracts, avg_entry_price, margin_usdt, stop_price, stop_order_ref, stop_contracts,
       protection_status, exchange_position_ref, exchange_synced_at, close_reason, opened_at, closed_at,
       to_jsonb(pos) ->> 'exchange_close_state' AS exchange_close_state_if_migrated
FROM positions pos WHERE pos.id = :'pid';

\echo '== Every Live order on XAU_USDT since the position opened (state_reason holds the MEXC response)'
SELECT o.id, o.kind, o.side, o.exit_reason, o.state, o.state_reason, o.client_order_id, length(o.client_order_id) AS oid_len,
       o.contracts, o.filled_contracts, o.reserved_usdt, o.created_at, o.submitted_at, o.resolved_at, o.event_id
FROM order_intents o
WHERE o.paper_account_id = :'acct' AND o.instrument_id = :'inst' AND o.mode = 'LIVE' AND o.created_at >= :'opened'::timestamptz - interval '5 minutes'
ORDER BY o.created_at;

\echo '== Fills of those orders (mexc:<orderId>)'
SELECT f.intent_id, f.exchange_fill_id, f.side, f.contracts, f.price, f.fee, f.filled_at
FROM fills f WHERE f.intent_id IN (SELECT o.id FROM order_intents o WHERE o.paper_account_id = :'acct' AND o.instrument_id = :'inst' AND o.created_at >= :'opened'::timestamptz - interval '5 minutes');

\echo '== Jobs of those orders (paper.close / paper.reverse / paper.submit)'
SELECT j.kind, j.status, j.attempts, j.max_attempts, left(j.last_error, 300) AS last_error, j.run_after, j.completed_at, j.payload
FROM jobs j
WHERE j.payload->>'intentId' IN (SELECT o.id::text FROM order_intents o WHERE o.paper_account_id = :'acct' AND o.instrument_id = :'inst' AND o.created_at >= :'opened'::timestamptz - interval '5 minutes')
   OR j.payload->>'closeIntentId' IN (SELECT o.id::text FROM order_intents o WHERE o.paper_account_id = :'acct' AND o.instrument_id = :'inst' AND o.created_at >= :'opened'::timestamptz - interval '5 minutes')
ORDER BY j.created_at;

\echo '== 00:50 alert: decisions for this investor (exit step and the reversal opening leg)'
SELECT e.action, e.bar_close_at, e.received_at, d.step, d.status, d.reason, d.detail->>'reasonText' AS reason_text,
       d.detail->>'closeState' AS close_state, d.detail->>'remainingContracts' AS remaining,
       d.detail->>'requiredUsdt' AS required_usdt, d.detail->>'availableUsdt' AS available_usdt, d.detail->'liveBlockers' AS live_blockers, d.evaluated_at
FROM signal_decisions d JOIN signal_events e ON e.id = d.event_id
WHERE d.owner_id = :'uid' AND e.received_at BETWEEN '2026-11-14 00:40+06' AND '2026-11-14 01:10+06'
ORDER BY d.evaluated_at;

\echo '== Did a short get submitted? (Live OPEN SHORT orders on XAU since 00:40)'
SELECT o.id, o.state, o.state_reason, o.client_order_id, o.contracts, o.reserved_usdt, o.created_at
FROM order_intents o JOIN instruments i ON i.id = o.instrument_id
WHERE o.owner_id = :'uid' AND upper(i.exchange_symbol) = 'XAU_USDT' AND o.mode = 'LIVE' AND o.kind = 'OPEN' AND o.side = 'SHORT' AND o.created_at >= '2026-11-14 00:40+06';

\echo '== Error 2030 anywhere on these orders or jobs?'
SELECT 'intent' AS what, o.id::text, o.state_reason AS text FROM order_intents o WHERE o.owner_id = :'uid' AND o.created_at >= '2026-11-13 23:30+06' AND o.state_reason ILIKE '%2030%'
UNION ALL
SELECT 'job', j.id::text, left(j.last_error, 300) FROM jobs j WHERE j.created_at >= '2026-11-13 23:30+06' AND j.last_error ILIKE '%2030%';

\echo '== Exits booked for the position'
SELECT reason, exchange_fill_id, contracts, price, fee, realized_pnl, remaining_contracts, intent_id, filled_at FROM position_exits WHERE position_id = :'pid' ORDER BY filled_at;

\echo '== Live account balances (local) and last MEXC balance'
SELECT wallet_balance, position_margin, order_reserve, exchange_equity, exchange_available, exchange_synced_at
FROM paper_accounts WHERE owner_id = :'uid' AND mode = 'LIVE';

\echo '== Recent private-sync audit rows (admin / investor / ops runs)'
SELECT action, result, metadata, created_at FROM audit_events
WHERE action IN ('ADMIN_LIVE_SYNC', 'INVESTOR_LIVE_SYNC', 'OPS_LIVE_SYNC', 'LIVE_ENTRIES_HALT') AND created_at >= '2026-11-13 23:00+06'
ORDER BY created_at DESC LIMIT 15;

\echo '== Untouched: the 13 Nov 16:50 expired orders and their DEAD jobs'
SELECT o.id, o.state, left(o.state_reason, 80) AS state_reason, j.status AS job_status, j.attempts
FROM order_intents o LEFT JOIN jobs j ON j.payload->>'intentId' = o.id::text AND j.kind = 'paper.submit'
WHERE o.id IN ('49d3b4f2-93ba-40ae-b0b0-5c83991125c1', '69d07f47-bd74-4296-bbce-d944af9437a8');

ROLLBACK;
