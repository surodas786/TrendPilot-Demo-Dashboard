CREATE TYPE "public"."intent_state" AS ENUM('INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."position_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."protection_status" AS ENUM('PENDING', 'PROTECTED', 'UNPROTECTED');--> statement-breakpoint
ALTER TYPE "public"."decision_status" ADD VALUE 'ENTRY_APPROVED';--> statement-breakpoint
CREATE TABLE "fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"paper_account_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"exchange_fill_id" text NOT NULL,
	"side" text NOT NULL,
	"contracts" numeric(28, 12) NOT NULL,
	"price" numeric(32, 12) NOT NULL,
	"fee" numeric(28, 8) NOT NULL,
	"filled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"paper_account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"bucket" text NOT NULL,
	"amount" numeric(28, 8) NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_candles" (
	"instrument_id" uuid NOT NULL,
	"interval" text NOT NULL,
	"open_time" timestamp with time zone NOT NULL,
	"open" numeric(32, 12) NOT NULL,
	"high" numeric(32, 12) NOT NULL,
	"low" numeric(32, 12) NOT NULL,
	"close" numeric(32, 12) NOT NULL,
	"closed" boolean NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_candles_instrument_id_interval_open_time_pk" PRIMARY KEY("instrument_id","interval","open_time"),
	CONSTRAINT "market_candles_interval_valid" CHECK ("market_candles"."interval" IN ('5', '15'))
);
--> statement-breakpoint
CREATE TABLE "market_quotes" (
	"instrument_id" uuid NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"bid" numeric(32, 12) NOT NULL,
	"ask" numeric(32, 12) NOT NULL,
	"mark" numeric(32, 12) NOT NULL,
	"last" numeric(32, 12) NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_quotes_instrument_id_as_of_pk" PRIMARY KEY("instrument_id","as_of"),
	CONSTRAINT "market_quotes_book" CHECK ("market_quotes"."ask" >= "market_quotes"."bid" AND "market_quotes"."bid" > 0)
);
--> statement-breakpoint
CREATE TABLE "order_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"paper_account_id" uuid NOT NULL,
	"order_block_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"mode" "trading_mode" NOT NULL,
	"kind" text NOT NULL,
	"side" text NOT NULL,
	"client_order_id" text NOT NULL,
	"state" "intent_state" DEFAULT 'INTENT' NOT NULL,
	"state_reason" text,
	"contracts" numeric(28, 12) NOT NULL,
	"quantity" numeric(28, 12) NOT NULL,
	"expected_price" numeric(32, 12) NOT NULL,
	"stop_price" numeric(32, 12) NOT NULL,
	"stop_basis" text NOT NULL,
	"leverage" integer NOT NULL,
	"margin_mode" "margin_mode" NOT NULL,
	"reserved_usdt" numeric(28, 8) NOT NULL,
	"sizing" jsonb NOT NULL,
	"settings_snapshot" jsonb NOT NULL,
	"submitted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_intents_side_valid" CHECK ("order_intents"."side" IN ('LONG', 'SHORT')),
	CONSTRAINT "order_intents_positive" CHECK ("order_intents"."contracts" > 0 AND "order_intents"."reserved_usdt" > 0)
);
--> statement-breakpoint
CREATE TABLE "paper_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"currency" text DEFAULT 'USDT' NOT NULL,
	"wallet_balance" numeric(28, 8) NOT NULL,
	"position_margin" numeric(28, 8) DEFAULT '0' NOT NULL,
	"order_reserve" numeric(28, 8) DEFAULT '0' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_accounts_nonnegative" CHECK ("paper_accounts"."wallet_balance" >= 0 AND "paper_accounts"."position_margin" >= 0 AND "paper_accounts"."order_reserve" >= 0)
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"paper_account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"order_block_id" uuid NOT NULL,
	"open_intent_id" uuid NOT NULL,
	"mode" "trading_mode" NOT NULL,
	"side" text NOT NULL,
	"status" "position_status" DEFAULT 'OPEN' NOT NULL,
	"contracts" numeric(28, 12) NOT NULL,
	"initial_contracts" numeric(28, 12) NOT NULL,
	"quantity" numeric(28, 12) NOT NULL,
	"avg_entry_price" numeric(32, 12) NOT NULL,
	"leverage" integer NOT NULL,
	"margin_mode" "margin_mode" NOT NULL,
	"margin_usdt" numeric(28, 8) NOT NULL,
	"liquidation_estimate" numeric(32, 12) NOT NULL,
	"stop_price" numeric(32, 12) NOT NULL,
	"stop_basis" text NOT NULL,
	"stop_order_ref" text,
	"stop_contracts" numeric(28, 12),
	"protection_status" "protection_status" DEFAULT 'PENDING' NOT NULL,
	"protection_verified_at" timestamp with time zone,
	"settings_snapshot" jsonb NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_fills" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"paper_account_id" uuid NOT NULL,
	"contracts" numeric(28, 12) NOT NULL,
	"price" numeric(32, 12) NOT NULL,
	"fee" numeric(28, 8) NOT NULL,
	"filled_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paper_account_id" uuid NOT NULL,
	"client_order_id" text NOT NULL,
	"instrument_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"side" text NOT NULL,
	"contracts" numeric(28, 12) NOT NULL,
	"status" text NOT NULL,
	"reduce_only" boolean DEFAULT false NOT NULL,
	"trigger_price" numeric(32, 12),
	"trigger_basis" text,
	"parent_order_id" uuid,
	"reject_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_paper_account_id_paper_accounts_id_fk" FOREIGN KEY ("paper_account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_intent_id_order_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."order_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_paper_account_id_paper_accounts_id_fk" FOREIGN KEY ("paper_account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_candles" ADD CONSTRAINT "market_candles_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_quotes" ADD CONSTRAINT "market_quotes_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_intents" ADD CONSTRAINT "order_intents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_intents" ADD CONSTRAINT "order_intents_paper_account_id_paper_accounts_id_fk" FOREIGN KEY ("paper_account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_intents" ADD CONSTRAINT "order_intents_order_block_id_order_blocks_id_fk" FOREIGN KEY ("order_block_id") REFERENCES "public"."order_blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_intents" ADD CONSTRAINT "order_intents_decision_id_signal_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."signal_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_intents" ADD CONSTRAINT "order_intents_event_id_signal_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."signal_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_intents" ADD CONSTRAINT "order_intents_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_accounts" ADD CONSTRAINT "paper_accounts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_paper_account_id_paper_accounts_id_fk" FOREIGN KEY ("paper_account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_order_block_id_order_blocks_id_fk" FOREIGN KEY ("order_block_id") REFERENCES "public"."order_blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_open_intent_id_order_intents_id_fk" FOREIGN KEY ("open_intent_id") REFERENCES "public"."order_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_fills" ADD CONSTRAINT "sim_fills_order_id_sim_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sim_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_fills" ADD CONSTRAINT "sim_fills_paper_account_id_paper_accounts_id_fk" FOREIGN KEY ("paper_account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_orders" ADD CONSTRAINT "sim_orders_paper_account_id_paper_accounts_id_fk" FOREIGN KEY ("paper_account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_orders" ADD CONSTRAINT "sim_orders_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fills_account_fill_key" ON "fills" USING btree ("paper_account_id","exchange_fill_id");--> statement-breakpoint
CREATE INDEX "fills_owner_idx" ON "fills" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_once_key" ON "ledger_entries" USING btree ("paper_account_id","kind","ref_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_owner_idx" ON "ledger_entries" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_intents_decision_key" ON "order_intents" USING btree ("decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_intents_client_order_key" ON "order_intents" USING btree ("client_order_id");--> statement-breakpoint
CREATE INDEX "order_intents_owner_idx" ON "order_intents" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_intents_one_unresolved_per_scope" ON "order_intents" USING btree ("paper_account_id","instrument_id","mode") WHERE "order_intents"."state" IN ('INTENT', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN');--> statement-breakpoint
CREATE UNIQUE INDEX "paper_accounts_owner_key" ON "paper_accounts" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_open_intent_key" ON "positions" USING btree ("open_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_one_open_per_scope" ON "positions" USING btree ("paper_account_id","instrument_id","mode") WHERE "positions"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "positions_owner_idx" ON "positions" USING btree ("owner_id","opened_at");--> statement-breakpoint
CREATE INDEX "sim_fills_order_idx" ON "sim_fills" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sim_orders_client_key" ON "sim_orders" USING btree ("client_order_id");--> statement-breakpoint
CREATE INDEX "sim_orders_parent_idx" ON "sim_orders" USING btree ("parent_order_id");