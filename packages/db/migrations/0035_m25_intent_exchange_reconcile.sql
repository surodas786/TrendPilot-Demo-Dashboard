-- Unresolved Live order intents are reconciled from exchange evidence outside their submit job
-- (REST sync, private WebSocket order events, ops recovery). The exchange's own order ID is kept
-- with the intent once Bitunix reports it; each reconciliation attempt records when it ran and
-- what the exchange showed, so an unresolved order is visible with its age and last check.
ALTER TABLE "order_intents" ADD COLUMN "exchange_order_id" text;--> statement-breakpoint
ALTER TABLE "order_intents" ADD COLUMN "reconcile_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_intents" ADD COLUMN "last_reconcile_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_intents" ADD COLUMN "last_reconcile_note" text;
