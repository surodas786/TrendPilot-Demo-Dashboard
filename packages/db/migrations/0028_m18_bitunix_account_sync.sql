-- Bitunix Step 2 (read-only account sync). Additive only: two new tables for the per-connection
-- exchange account mirror, and two jsonb columns on exchange_connections that default to '{}'.
-- No existing row is rewritten; MEXC connections, positions, orders, fills and ledgers are untouched
-- (MEXC rows simply carry account_state = stream_state = '{}' and never read the new tables).
CREATE TABLE "exchange_account_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"exchange" text NOT NULL,
	"kind" text NOT NULL,
	"dedup_key" text NOT NULL,
	"origin" text NOT NULL,
	"source" text NOT NULL,
	"exchange_position_id" text,
	"exchange_order_id" text,
	"symbol" text,
	"side" text,
	"qty_before" numeric,
	"qty_after" numeric,
	"business_time" timestamp with time zone,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_account_events_origin_valid" CHECK ("exchange_account_events"."origin" IN ('EXCHANGE', 'TRENDPILOT')),
	CONSTRAINT "exchange_account_events_source_valid" CHECK ("exchange_account_events"."source" IN ('REST', 'WS', 'HISTORY'))
);
--> statement-breakpoint
CREATE TABLE "exchange_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"exchange" text NOT NULL,
	"exchange_position_id" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"position_mode" text,
	"margin_mode" text,
	"leverage" integer,
	"qty" numeric NOT NULL,
	"max_qty" numeric,
	"avg_open_price" numeric,
	"liq_price" numeric,
	"margin" numeric,
	"unrealized_pnl" numeric,
	"realized_pnl" numeric,
	"reported_fee" numeric,
	"reported_funding" numeric,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"close_check" text DEFAULT 'NONE' NOT NULL,
	"close_check_since" timestamp with time zone,
	"close_check_reason" text,
	"close_price" numeric,
	"closed_at" timestamp with time zone,
	"settled_fee" numeric,
	"settled_funding" numeric,
	"settled_realized_pnl" numeric,
	"origin" text DEFAULT 'EXCHANGE' NOT NULL,
	"opened_at" timestamp with time zone,
	"exchange_updated_at" timestamp with time zone,
	"last_source" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_positions_side_valid" CHECK ("exchange_positions"."side" IN ('LONG', 'SHORT')),
	CONSTRAINT "exchange_positions_status_valid" CHECK ("exchange_positions"."status" IN ('OPEN', 'CLOSED', 'DETACHED')),
	CONSTRAINT "exchange_positions_close_check_valid" CHECK ("exchange_positions"."close_check" IN ('NONE', 'PENDING')),
	CONSTRAINT "exchange_positions_origin_valid" CHECK ("exchange_positions"."origin" IN ('EXCHANGE', 'TRENDPILOT')),
	CONSTRAINT "exchange_positions_qty_nonneg" CHECK ("exchange_positions"."qty" >= 0)
);
--> statement-breakpoint
ALTER TABLE "exchange_connections" ADD COLUMN "account_state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_connections" ADD COLUMN "stream_state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_account_events" ADD CONSTRAINT "exchange_account_events_connection_id_exchange_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."exchange_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_account_events" ADD CONSTRAINT "exchange_account_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_positions" ADD CONSTRAINT "exchange_positions_connection_id_exchange_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."exchange_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_positions" ADD CONSTRAINT "exchange_positions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_account_events_dedup_key" ON "exchange_account_events" USING btree ("connection_id","dedup_key");--> statement-breakpoint
CREATE INDEX "exchange_account_events_connection_idx" ON "exchange_account_events" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_positions_connection_position_key" ON "exchange_positions" USING btree ("connection_id","exchange_position_id");--> statement-breakpoint
CREATE INDEX "exchange_positions_owner_idx" ON "exchange_positions" USING btree ("owner_id","status");