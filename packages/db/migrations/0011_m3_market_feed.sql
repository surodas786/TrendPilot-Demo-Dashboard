CREATE TABLE "market_feed_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"window_from" timestamp with time zone,
	"window_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_feed_status" (
	"instrument_id" uuid NOT NULL,
	"source" text NOT NULL,
	"exchange_symbol" text NOT NULL,
	"state" text DEFAULT 'STARTING' NOT NULL,
	"state_since" timestamp with time zone DEFAULT now() NOT NULL,
	"last_quote_at" timestamp with time zone,
	"last_exchange_time" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_candle_open" jsonb,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"last_error" text,
	"clock_offset_ms" integer,
	"contract_check" jsonb,
	"contract_checked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_feed_status_instrument_id_source_pk" PRIMARY KEY("instrument_id","source"),
	CONSTRAINT "market_feed_status_state_valid" CHECK ("market_feed_status"."state" IN ('STARTING', 'HEALTHY', 'STALE', 'DOWN', 'CLOCK_SKEW', 'SYMBOL_UNAVAILABLE'))
);
--> statement-breakpoint
ALTER TABLE "market_feed_events" ADD CONSTRAINT "market_feed_events_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_feed_status" ADD CONSTRAINT "market_feed_status_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_feed_events_created_idx" ON "market_feed_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "market_feed_events_instrument_idx" ON "market_feed_events" USING btree ("instrument_id","created_at");