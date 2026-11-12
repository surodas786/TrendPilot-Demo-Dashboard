-- Per-side Take Profit. "take_profit" now holds the Long configuration (column name kept);
-- "take_profit_short" is new. Existing Trade Settings start with their current shared
-- configuration on BOTH sides. Open positions keep the exit plan saved with them.
ALTER TABLE "order_blocks" ADD COLUMN "take_profit_short" jsonb;--> statement-breakpoint
UPDATE "order_blocks" SET "take_profit_short" = "take_profit";--> statement-breakpoint
ALTER TABLE "order_blocks" ALTER COLUMN "take_profit_short" SET NOT NULL;
