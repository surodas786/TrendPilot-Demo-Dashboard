ALTER TABLE "order_intents" ADD COLUMN "venue_request" jsonb;--> statement-breakpoint
ALTER TABLE "order_intents" ADD COLUMN "venue_response" jsonb;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "exit_halted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "exit_halt_reason" text;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "exit_halt_intent_id" uuid;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "exit_retry_from" timestamp with time zone;--> statement-breakpoint
-- Open Live positions whose close was already refused deterministically by MEXC (e.g. 2001 on
-- 14 Nov 2026) start halted: deploying this fix must not replay the old automatic exit on the
-- next price. The exchange stop is untouched; an operator clears the halt (ops:exit-halt --clear).
UPDATE "positions" p
SET "exit_halted_at" = now(),
    "exit_halt_reason" = r.state_reason || ' on ' || coalesce(r.exit_reason, 'CLOSE') || ' ' || r.client_order_id || ' (backfilled by 0026)',
    "exit_halt_intent_id" = r.id,
    "updated_at" = now()
FROM (
  SELECT DISTINCT ON (o.position_id) o.position_id, o.id, o.state_reason, o.exit_reason, o.client_order_id
  FROM "order_intents" o
  WHERE o.kind = 'CLOSE' AND o.mode = 'LIVE' AND o.state = 'REJECTED'
    AND o.state_reason ~ '^MEXC_(401|402|403|406|600|602|1001|1002|1004|2001|2002|2011|2015|2022|2027|2029|2030)$'
  ORDER BY o.position_id, o.created_at DESC
) r
WHERE p.id = r.position_id AND p.status = 'OPEN' AND p.mode = 'LIVE' AND p.exit_halted_at IS NULL;
