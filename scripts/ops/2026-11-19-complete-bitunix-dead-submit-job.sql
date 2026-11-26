-- 19 Nov 2026: paper.submit job 8c41c9a8-8ba0-4b73-b1d7-183486689fa1 went DEAD (8/8) on
--   BitunixPrivateError: position 403163326623575343: unknown position side "SELL"
-- Its intent a904dfdd-4947-4130-ad77-8c1f8afb93a2 was then settled from Bitunix evidence by the
-- worker's reconciliation (ffbba38, 12:29:10Z): FILLED, fill bitunix:2123382089013051392, position
-- linked to 403163326623575343, reservation converted. The job's work is done; this marks it DONE
-- the way completeJob does, keeping the original error text for the record.
--
-- Guarded: changes exactly this one job, only while it is DEAD and its intent is FILLED with a
-- booked fill and position. Otherwise it updates nothing (UPDATE 0) and the transaction rolls back.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/2026-11-19-complete-bitunix-dead-submit-job.sql

BEGIN;

SELECT j.id, j.status, j.attempts, j.max_attempts, j.last_error, i.state AS intent_state,
       (SELECT count(*) FROM fills f WHERE f.intent_id = i.id) AS fills,
       (SELECT count(*) FROM positions p WHERE p.open_intent_id = i.id) AS positions
FROM jobs j
JOIN order_intents i ON j.dedupe_key = 'paper.submit:' || i.id::text
WHERE j.id = '8c41c9a8-8ba0-4b73-b1d7-183486689fa1';

UPDATE jobs j
SET status = 'DONE',
    completed_at = now(),
    claim_expires_at = NULL,
    last_error = left('Resolved by exchange reconciliation 2026-11-19T12:29:10Z (intent FILLED, order 2123382089013051392); job error was: ' || coalesce(j.last_error, ''), 2000),
    updated_at = now()
FROM order_intents i
WHERE j.id = '8c41c9a8-8ba0-4b73-b1d7-183486689fa1'
  AND j.status = 'DEAD'
  AND j.dedupe_key = 'paper.submit:' || i.id::text
  AND i.id = 'a904dfdd-4947-4130-ad77-8c1f8afb93a2'
  AND i.state = 'FILLED'
  AND EXISTS (SELECT 1 FROM fills f WHERE f.intent_id = i.id AND f.exchange_fill_id = 'bitunix:2123382089013051392')
  AND EXISTS (SELECT 1 FROM positions p WHERE p.open_intent_id = i.id)
RETURNING j.id, j.status, j.completed_at, j.last_error;

SELECT id, status, attempts, completed_at, last_error FROM jobs WHERE id = '8c41c9a8-8ba0-4b73-b1d7-183486689fa1';

COMMIT;
