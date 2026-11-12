CREATE TABLE "exchange_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"exchange" text DEFAULT 'MEXC' NOT NULL,
	"account_ref" text NOT NULL,
	"api_key_sealed" text NOT NULL,
	"secret_sealed" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"verification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verified_at" timestamp with time zone,
	"position_mode" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"max_order_contracts" numeric(28, 12),
	"max_order_notional_usdt" numeric(28, 8),
	"max_leverage" integer,
	"max_exposure_usdt" numeric(28, 8),
	"live_enabled" boolean DEFAULT false NOT NULL,
	"activated_at" timestamp with time zone,
	"entries_halted" boolean DEFAULT false NOT NULL,
	"halt_reason" text,
	"halted_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_sync_error" text,
	"drift" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_connections_status_valid" CHECK ("exchange_connections"."status" IN ('PENDING', 'VERIFIED', 'FAILED', 'REVOKED')),
	CONSTRAINT "exchange_connections_position_mode_valid" CHECK ("exchange_connections"."position_mode" IS NULL OR "exchange_connections"."position_mode" IN ('ONE_WAY', 'HEDGE')),
	CONSTRAINT "exchange_connections_limits_valid" CHECK (("exchange_connections"."approved_at" IS NULL) OR ("exchange_connections"."max_order_contracts" > 0 AND "exchange_connections"."max_order_notional_usdt" > 0 AND "exchange_connections"."max_exposure_usdt" >= "exchange_connections"."max_order_notional_usdt" AND "exchange_connections"."max_leverage" BETWEEN 1 AND 125)),
	CONSTRAINT "exchange_connections_activation_needs_approval" CHECK ("exchange_connections"."live_enabled" = false OR ("exchange_connections"."approved_at" IS NOT NULL AND "exchange_connections"."status" = 'VERIFIED'))
);
--> statement-breakpoint
CREATE TABLE "live_control" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"live_enabled" boolean DEFAULT false NOT NULL,
	"entries_halted" boolean DEFAULT false NOT NULL,
	"halt_reason" text,
	"halted_at" timestamp with time zone,
	"capability_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text,
	"updated_by" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_control_singleton" CHECK ("live_control"."id" = 1)
);
--> statement-breakpoint
DROP INDEX "paper_accounts_owner_key";--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "live_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_accounts" ADD COLUMN "mode" "trading_mode" DEFAULT 'PAPER' NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_accounts" ADD COLUMN "exchange_equity" numeric(28, 8);--> statement-breakpoint
ALTER TABLE "paper_accounts" ADD COLUMN "exchange_available" numeric(28, 8);--> statement-breakpoint
ALTER TABLE "paper_accounts" ADD COLUMN "exchange_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "exchange_position_ref" text;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "exchange_liquidation_price" numeric(32, 12);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "exchange_funding_usdt" numeric(28, 8);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "exchange_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exchange_connections" ADD CONSTRAINT "exchange_connections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_connections" ADD CONSTRAINT "exchange_connections_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_control" ADD CONSTRAINT "live_control_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_connections_owner_key" ON "exchange_connections" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_accounts_owner_mode_key" ON "paper_accounts" USING btree ("owner_id","mode");--> statement-breakpoint
-- Live ships switched off: the platform switch row exists with live_enabled = false.
INSERT INTO "live_control" ("id", "live_enabled", "entries_halted") VALUES (1, false, false) ON CONFLICT ("id") DO NOTHING;
