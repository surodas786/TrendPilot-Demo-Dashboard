-- Live manual-close reconciliation: per-position MEXC quantity and FILLS_PENDING state, and the
-- connection's last fully successful sync (a failed attempt moves last_sync_at only).
ALTER TABLE "exchange_connections" ADD COLUMN "last_sync_ok_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "exchange_contracts" numeric(28, 12);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "exchange_close_state" text;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "exchange_flat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_exchange_close_state_valid" CHECK ("positions"."exchange_close_state" IS NULL OR "positions"."exchange_close_state" IN ('FILLS_PENDING'));--> statement-breakpoint
UPDATE "exchange_connections" SET "last_sync_ok_at" = "last_sync_at" WHERE "last_sync_error" IS NULL AND "last_sync_at" IS NOT NULL;
