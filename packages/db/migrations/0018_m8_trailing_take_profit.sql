ALTER TABLE "positions" DROP CONSTRAINT "positions_trailing_status_valid";--> statement-breakpoint
ALTER TABLE "order_blocks" ADD COLUMN "trailing_conversion_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_kind" text DEFAULT 'TAKE_PROFIT' NOT NULL;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_trailing_kind_valid" CHECK ("positions"."trailing_kind" IN ('TAKE_PROFIT', 'STOP'));--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_trailing_status_valid" CHECK ("positions"."trailing_status" IN ('OFF', 'WAITING', 'ACTIVE', 'DONE'));--> statement-breakpoint
-- Trailing Take Profit replaces the trailing stop for new entries. Every position that already
-- has a trailing exit keeps the behaviour saved with it (legacy trailing stop).
UPDATE "positions" SET "trailing_kind" = 'STOP' WHERE "trailing_status" <> 'OFF';--> statement-breakpoint
-- Blocks saved with the old trailing stop on are not converted automatically: the activation
-- value must be entered explicitly (never derived from the old distance). Until then, new
-- entries from these blocks are held.
UPDATE "order_blocks" SET "trailing_conversion_required" = true WHERE ("trailing"->>'enabled')::boolean IS TRUE;
