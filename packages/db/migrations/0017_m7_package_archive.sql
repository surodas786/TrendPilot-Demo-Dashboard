ALTER TABLE "strategy_packages" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "strategy_packages" ADD COLUMN "archived_by" uuid;--> statement-breakpoint
ALTER TABLE "strategy_packages" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;