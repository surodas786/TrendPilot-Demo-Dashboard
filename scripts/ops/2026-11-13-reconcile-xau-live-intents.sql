-- Reconcile the two Live XAU_USDT entries of the 13 Nov 2026 16:50 Asia/Dhaka alert that were never
-- sent to MEXC (verified per account: lookup by client order ID returns no order, no XAU deals since
-- 10:45 UTC, no XAU position, no XAU stop). Mirrors the app's release(): intent -> EXPIRED, one
-- ORDER_RESERVE_RELEASE ledger row, order_reserve reduced by exactly that intent's reservation.
-- Leaves the two DEAD paper.submit jobs untouched. Run with -v commit=false (default) for a dry run.
\set ON_ERROR_STOP on
\pset pager off
\if :{?commit}
\else
  \set commit false
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TEMP TABLE recon (intent_id uuid PRIMARY KEY, client_order_id text NOT NULL, owner_email text NOT NULL, account_id uuid NOT NULL, expected_reserved numeric NOT NULL) ON COMMIT DROP;
INSERT INTO recon VALUES
  ('49d3b4f2-93ba-40ae-b0b0-5c83991125c1', 'tp-310c38b4-d4e1-4183-84ef-9a59bb904355', 'surodas@proton.me',        '0f767f22-2f9a-48f9-9cb6-65fd167604d1', 301.08960000),
  ('69d07f47-bd74-4296-bbce-d944af9437a8', 'tp-0f1f90f5-768d-462d-8422-436378c92bdf', 'shaheenalamgir@proton.me', 'fc0da536-a95f-4b6f-a504-cda84fd69c2b', 301.08960000);

-- Lock the rows the release touches (same order as the app: account, then intent).
SELECT id FROM paper_accounts WHERE id IN (SELECT account_id FROM recon) ORDER BY id FOR UPDATE;
SELECT id FROM order_intents  WHERE id IN (SELECT intent_id FROM recon) ORDER BY id FOR UPDATE;

CREATE TEMP TABLE before_acct ON COMMIT DROP AS
  SELECT id, order_reserve FROM paper_accounts WHERE id IN (SELECT account_id FROM recon);

\echo '== PRE-CHECKS (every column must be t)'
CREATE TEMP TABLE pre ON COMMIT DROP AS
SELECT r.intent_id,
       o.id IS NOT NULL                                                         AS intent_exists,
       o.client_order_id = r.client_order_id                                    AS client_order_id_ok,
       o.state = 'SUBMITTING'                                                   AS state_submitting,
       o.mode = 'LIVE' AND o.kind = 'OPEN' AND o.side = 'SHORT'                 AS live_open_short,
       u.email = r.owner_email                                                  AS owner_email_ok,
       o.paper_account_id = r.account_id AND a.owner_id = o.owner_id AND a.mode = 'LIVE' AS account_owned_live,
       o.reserved_usdt = r.expected_reserved                                    AS reservation_ok,
       (SELECT count(*) FROM ledger_entries l WHERE l.paper_account_id = r.account_id AND l.kind = 'ORDER_RESERVE' AND l.ref_id = r.intent_id::text AND l.amount = r.expected_reserved) = 1 AS reserve_row_once,
       (SELECT count(*) FROM ledger_entries l WHERE l.paper_account_id = r.account_id AND l.kind = 'ORDER_RESERVE_RELEASE' AND l.ref_id = r.intent_id::text) = 0 AS not_yet_released,
       (SELECT count(*) FROM fills f WHERE f.intent_id = r.intent_id) = 0       AS no_fills,
       (SELECT count(*) FROM positions p WHERE p.open_intent_id = r.intent_id) = 0 AS no_position,
       a.order_reserve >= r.expected_reserved                                   AS reserve_covers,
       (SELECT j.status FROM jobs j WHERE j.payload->>'intentId' = r.intent_id::text AND j.kind = 'paper.submit') = 'DEAD' AS job_dead_untouched
FROM recon r
LEFT JOIN order_intents o ON o.id = r.intent_id
LEFT JOIN users u ON u.id = o.owner_id
LEFT JOIN paper_accounts a ON a.id = r.account_id;
\x on
SELECT * FROM pre ORDER BY intent_id;
\x off
SELECT b.id AS account_id, b.order_reserve AS reserve_before,
       (SELECT coalesce(sum(amount), 0) FROM ledger_entries l WHERE l.paper_account_id = b.id AND l.bucket = 'ORDER_RESERVE') AS reserve_ledger_before
FROM before_acct b ORDER BY b.id;

DO $$
BEGIN
  IF (SELECT count(*) FROM pre WHERE intent_exists AND client_order_id_ok AND state_submitting AND live_open_short AND owner_email_ok AND account_owned_live
        AND reservation_ok AND reserve_row_once AND not_yet_released AND no_fills AND no_position AND reserve_covers AND job_dead_untouched) <> 2 THEN
    RAISE EXCEPTION 'PRE-CHECK FAILED: nothing changed (transaction aborted)';
  END IF;
END $$;

\echo '== RELEASE (one per order)'
CREATE TEMP TABLE released ON COMMIT DROP AS
WITH ins AS (
  INSERT INTO ledger_entries (owner_id, paper_account_id, kind, bucket, amount, ref_type, ref_id, memo)
  SELECT o.owner_id, o.paper_account_id, 'ORDER_RESERVE_RELEASE', 'ORDER_RESERVE', -o.reserved_usdt, 'order_intent', o.id::text,
         'Reservation released (RECONCILED_NOT_AT_VENUE: never sent to MEXC, 13 Nov XAU alert)'
  FROM order_intents o JOIN recon r ON r.intent_id = o.id
  ON CONFLICT (paper_account_id, kind, ref_id) DO NOTHING
  RETURNING paper_account_id, ref_id, amount)
SELECT * FROM ins;
SELECT * FROM released ORDER BY ref_id;

UPDATE order_intents o
   SET state = 'EXPIRED',
       state_reason = 'RECONCILED_NOT_AT_VENUE: MEXC has no order for this client order ID (lookup empty, no XAU deals/position/stop); submit failed before sending (TypeError, fixed in 874c844)',
       resolved_at = now(), updated_at = now()
  FROM recon r
 WHERE o.id = r.intent_id AND o.state = 'SUBMITTING';

UPDATE paper_accounts a
   SET order_reserve = a.order_reserve + x.delta, revision = a.revision + 1, updated_at = now()
  FROM (SELECT paper_account_id, sum(amount) AS delta FROM released GROUP BY paper_account_id) x
 WHERE a.id = x.paper_account_id;

\echo '== POST-CHECKS (every column must be t)'
CREATE TEMP TABLE post ON COMMIT DROP AS
SELECT r.intent_id,
       (SELECT count(*) FROM released x WHERE x.ref_id = r.intent_id::text) = 1                       AS one_release_inserted,
       (SELECT x.amount FROM released x WHERE x.ref_id = r.intent_id::text) = -r.expected_reserved    AS release_equals_reservation,
       (SELECT count(*) FROM ledger_entries l WHERE l.paper_account_id = r.account_id AND l.kind = 'ORDER_RESERVE_RELEASE' AND l.ref_id = r.intent_id::text) = 1 AS one_release_in_ledger,
       o.state = 'EXPIRED' AND o.resolved_at IS NOT NULL                                              AS intent_expired,
       a.order_reserve = b.order_reserve - r.expected_reserved                                        AS delta_exact_unrelated_kept,
       a.order_reserve = (SELECT coalesce(sum(amount), 0) FROM ledger_entries l WHERE l.paper_account_id = r.account_id AND l.bucket = 'ORDER_RESERVE') AS reserve_equals_ledger,
       a.order_reserve >= 0                                                                           AS reserve_not_negative,
       (SELECT j.status FROM jobs j WHERE j.payload->>'intentId' = r.intent_id::text AND j.kind = 'paper.submit') = 'DEAD' AS job_still_dead
FROM recon r
JOIN order_intents o ON o.id = r.intent_id
JOIN paper_accounts a ON a.id = r.account_id
JOIN before_acct b ON b.id = r.account_id;
\x on
SELECT * FROM post ORDER BY intent_id;
\x off
SELECT a.id AS account_id, b.order_reserve AS reserve_before, a.order_reserve AS reserve_after, b.order_reserve - a.order_reserve AS released
FROM paper_accounts a JOIN before_acct b ON b.id = a.id ORDER BY a.id;
SELECT count(*) AS untouched_dead_jobs FROM jobs WHERE id IN ('7bb5acda-93ae-453f-8702-aad53f2cb318', '5f1bcd37-591a-4597-adba-641d4e0a21e6') AND status = 'DEAD' AND attempts = 8;
SELECT entries_halted AS platform_halt_still_on FROM live_control;

DO $$
BEGIN
  IF (SELECT count(*) FROM post WHERE one_release_inserted AND release_equals_reservation AND one_release_in_ledger AND intent_expired
        AND delta_exact_unrelated_kept AND reserve_equals_ledger AND reserve_not_negative AND job_still_dead) <> 2 THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: rolling back';
  END IF;
  IF NOT (SELECT entries_halted FROM live_control) THEN RAISE EXCEPTION 'Platform halt is OFF: rolling back'; END IF;
END $$;

\if :commit
  \echo '== ALL CHECKS PASSED: COMMIT'
  COMMIT;
\else
  \echo '== ALL CHECKS PASSED: DRY RUN, ROLLBACK (re-run with -v commit=true to apply)'
  ROLLBACK;
\endif
