ALTER TYPE "public"."decision_status" ADD VALUE 'EXIT_REQUESTED';--> statement-breakpoint
ALTER TYPE "public"."decision_status" ADD VALUE 'HELD';--> statement-breakpoint
CREATE TABLE "position_exits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"paper_account_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"intent_id" uuid,
	"reason" text NOT NULL,
	"exchange_fill_id" text NOT NULL,
	"contracts" numeric(28, 12) NOT NULL,
	"price" numeric(32, 12) NOT NULL,
	"fee" numeric(28, 8) NOT NULL,
	"realized_pnl" numeric(28, 8) NOT NULL,
	"margin_released" numeric(28, 8) NOT NULL,
	"remaining_contracts" numeric(28, 12) NOT NULL,
	"filled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_positions" (
	"paper_account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"side" text,
	"contracts" numeric(28, 12) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_positions_paper_account_id_instrument_id_pk" PRIMARY KEY("paper_account_id","instrument_id"),
	CONSTRAINT "sim_positions_nonnegative" CHECK ("sim_positions"."contracts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "order_intents" DROP CONSTRAINT "order_intents_positive";--> statement-breakpoint
ALTER TABLE "order_intents" ALTER COLUMN "decision_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_intents" ALTER COLUMN "event_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "market_quotes" ADD COLUMN "liquidity_contracts" numeric(28, 12);--> statement-breakpoint
ALTER TABLE "order_intents" ADD COLUMN "position_id" uuid;--> statement-breakpoint
ALTER TABLE "order_intents" ADD COLUMN "exit_reason" text;--> statement-breakpoint
ALTER TABLE "order_intents" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "order_intents" ADD COLUMN "requested_by" uuid;--> statement-breakpoint
ALTER TABLE "order_intents" ADD COLUMN "filled_contracts" numeric(28, 12) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "strategy_version_id" uuid;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "take_profit_price" numeric(32, 12);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "take_profit_basis" text;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "realized_pnl_usdt" numeric(28, 8) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "fees_usdt" numeric(28, 8) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "close_reason" text;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "position_exits" ADD CONSTRAINT "position_exits_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_exits" ADD CONSTRAINT "position_exits_paper_account_id_paper_accounts_id_fk" FOREIGN KEY ("paper_account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_exits" ADD CONSTRAINT "position_exits_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_exits" ADD CONSTRAINT "position_exits_intent_id_order_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."order_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_positions" ADD CONSTRAINT "sim_positions_paper_account_id_paper_accounts_id_fk" FOREIGN KEY ("paper_account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_positions" ADD CONSTRAINT "sim_positions_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "position_exits_fill_key" ON "position_exits" USING btree ("paper_account_id","exchange_fill_id");--> statement-breakpoint
CREATE INDEX "position_exits_position_idx" ON "position_exits" USING btree ("position_id");--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_intents_idempotency_key" ON "order_intents" USING btree ("owner_id","idempotency_key") WHERE "order_intents"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "order_intents_position_idx" ON "order_intents" USING btree ("position_id");--> statement-breakpoint
ALTER TABLE "order_intents" ADD CONSTRAINT "order_intents_kind_valid" CHECK ("order_intents"."kind" IN ('OPEN', 'CLOSE'));--> statement-breakpoint
ALTER TABLE "order_intents" ADD CONSTRAINT "order_intents_links" CHECK (("order_intents"."kind" = 'OPEN' AND "order_intents"."decision_id" IS NOT NULL) OR ("order_intents"."kind" = 'CLOSE' AND "order_intents"."position_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "order_intents" ADD CONSTRAINT "order_intents_positive" CHECK ("order_intents"."contracts" > 0 AND ("order_intents"."kind" <> 'OPEN' OR "order_intents"."reserved_usdt" > 0));