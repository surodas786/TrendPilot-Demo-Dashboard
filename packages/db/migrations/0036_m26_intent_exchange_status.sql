-- The exchange's own status for a TrendPilot order as last reported (private push or REST lookup),
-- ranked NEW < PART_FILLED < final: a push that arrives later but carries an earlier status (Bitunix
-- sent NEW with a later timestamp than FILLED for the same order on 19 Nov 2026) never regresses it.
ALTER TABLE "order_intents" ADD COLUMN "exchange_order_status" text;--> statement-breakpoint
ALTER TABLE "order_intents" ADD COLUMN "exchange_order_status_at" timestamp with time zone;
