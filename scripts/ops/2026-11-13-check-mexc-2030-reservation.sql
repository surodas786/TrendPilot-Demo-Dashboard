-- READ-ONLY check of the latest Live order rejected by MEXC with error 2030 (externalOid too long).
-- Shows the externalOid that was sent (the intent's stored client_order_id) and its length, whether
-- the intent reached a terminal state, and whether its reservation was released exactly once.
-- Runs in a READ ONLY transaction (the database refuses any write) and ends with ROLLBACK.
-- Nothing is retried, replayed or sent to MEXC.
--
--   psql -f scripts/ops/2026-11-13-check-mexc-2030-reservation.sql -d "$DATABASE_URL"
\set ON_ERROR_STOP on
\pset pager off

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

-- The target: the three most recent Live intents whose state reason mentions 2030 (inlined in each
-- query because a READ ONLY transaction cannot create even a temporary view).
\set target 'WITH target AS (SELECT o.* FROM order_intents o WHERE o.mode = ''LIVE'' AND o.state_reason LIKE ''%2030%'' ORDER BY o.created_at DESC LIMIT 3)'

\echo '== Latest Live intents rejected with 2030 (newest first): externalOid sent and its length'
\x on
:target
SELECT t.id AS intent_id, u.email, t.kind, t.side, t.state, t.state_reason,
       t.client_order_id AS external_oid_sent, length(t.client_order_id) AS external_oid_length,
       length(t.client_order_id) > 32 AS over_mexc_limit_32,
       t.state IN ('FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED') AS terminal_state,
       t.reserved_usdt, t.created_at, t.submitted_at, t.resolved_at
FROM target t JOIN users u ON u.id = t.owner_id
ORDER BY t.created_at DESC;

\echo '== Reservation: ORDER_RESERVE vs ORDER_RESERVE_RELEASE ledger rows per intent'
:target
SELECT t.id AS intent_id,
       (SELECT count(*) FROM ledger_entries l WHERE l.paper_account_id = t.paper_account_id AND l.kind = 'ORDER_RESERVE' AND l.ref_id = t.id::text) AS reserve_rows,
       (SELECT coalesce(sum(amount), 0) FROM ledger_entries l WHERE l.paper_account_id = t.paper_account_id AND l.kind = 'ORDER_RESERVE' AND l.ref_id = t.id::text) AS reserved,
       (SELECT count(*) FROM ledger_entries l WHERE l.paper_account_id = t.paper_account_id AND l.kind = 'ORDER_RESERVE_RELEASE' AND l.ref_id = t.id::text) AS release_rows,
       (SELECT coalesce(sum(amount), 0) FROM ledger_entries l WHERE l.paper_account_id = t.paper_account_id AND l.kind = 'ORDER_RESERVE_RELEASE' AND l.ref_id = t.id::text) AS released,
       (SELECT coalesce(sum(amount), 0) FROM ledger_entries l WHERE l.paper_account_id = t.paper_account_id AND l.bucket = 'ORDER_RESERVE' AND l.ref_id = t.id::text) = 0 AS reservation_net_zero,
       (SELECT max(l.memo) FROM ledger_entries l WHERE l.paper_account_id = t.paper_account_id AND l.kind = 'ORDER_RESERVE_RELEASE' AND l.ref_id = t.id::text) AS release_memo,
       (SELECT count(*) FROM fills f WHERE f.intent_id = t.id) AS fills,
       (SELECT count(*) FROM positions p WHERE p.open_intent_id = t.id) AS positions_opened
FROM target t ORDER BY t.created_at DESC;

\echo '== Account: order_reserve column vs ORDER_RESERVE ledger bucket (must match)'
:target
SELECT a.id AS account_id, a.mode, a.order_reserve,
       (SELECT coalesce(sum(amount), 0) FROM ledger_entries l WHERE l.paper_account_id = a.id AND l.bucket = 'ORDER_RESERVE') AS reserve_ledger,
       a.order_reserve = (SELECT coalesce(sum(amount), 0) FROM ledger_entries l WHERE l.paper_account_id = a.id AND l.bucket = 'ORDER_RESERVE') AS reserve_consistent,
       (SELECT count(*) FROM order_intents o WHERE o.paper_account_id = a.id AND o.state NOT IN ('FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED')) AS unresolved_intents
FROM paper_accounts a WHERE a.id IN (SELECT paper_account_id FROM target);

\echo '== Jobs for these intents (a DONE/DEAD job will not retry on its own)'
:target
SELECT j.payload->>'intentId' AS intent_id, j.kind, j.status, j.attempts, j.max_attempts, j.run_after, j.completed_at, left(j.last_error, 200) AS last_error
FROM jobs j WHERE j.payload->>'intentId' IN (SELECT id::text FROM target) ORDER BY j.run_after;
\x off

ROLLBACK;
