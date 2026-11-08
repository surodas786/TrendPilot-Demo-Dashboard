CREATE TYPE "public"."decision_status" AS ENUM('READY_FOR_EVALUATION', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."event_disposition" AS ENUM('DISPATCH', 'INFO_ONLY');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('ACCEPTED', 'DISPATCHED');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('PENDING', 'RUNNING', 'DONE', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."route_kind" AS ENUM('ACTIONABLE', 'INFO_ONLY');--> statement-breakpoint
CREATE TYPE "public"."signal_action" AS ENUM('BULLISH_FLIP', 'BEARISH_FLIP', 'CLOSE_LONG', 'CLOSE_SHORT');--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'PENDING' NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"claimed_by" text,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"order_block_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"step" text NOT NULL,
	"status" "decision_status" NOT NULL,
	"reason" text,
	"detail" jsonb NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingress_namespace" text NOT NULL,
	"route_id" uuid NOT NULL,
	"stream_key" text NOT NULL,
	"action" "signal_action" NOT NULL,
	"source_exchange" text NOT NULL,
	"source_symbol" text NOT NULL,
	"interval" text NOT NULL,
	"instrument_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"bar_open_at" timestamp with time zone NOT NULL,
	"bar_close_at" timestamp with time zone NOT NULL,
	"alert_fired_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"reference_price" numeric(32, 12) NOT NULL,
	"disposition" "event_disposition" NOT NULL,
	"status" "event_status" DEFAULT 'ACCEPTED' NOT NULL,
	"dispatched_at" timestamp with time zone,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_events_bar_order" CHECK ("signal_events"."bar_close_at" > "signal_events"."bar_open_at")
);
--> statement-breakpoint
CREATE TABLE "signal_rejections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingress_namespace" text,
	"route_id" uuid,
	"reason" text NOT NULL,
	"http_status" integer NOT NULL,
	"detail" jsonb,
	"received_at" timestamp with time zone NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingress_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_exchange" text NOT NULL,
	"source_symbol" text NOT NULL,
	"interval" text NOT NULL,
	"action" "signal_action" NOT NULL,
	"kind" "route_kind" DEFAULT 'ACTIONABLE' NOT NULL,
	"instrument_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"max_signal_age_seconds" integer DEFAULT 120 NOT NULL,
	"clock_tolerance_seconds" integer DEFAULT 5 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_routes_interval_valid" CHECK ("signal_routes"."interval" IN ('5', '15')),
	CONSTRAINT "signal_routes_age_range" CHECK ("signal_routes"."max_signal_age_seconds" BETWEEN 10 AND 3600),
	CONSTRAINT "signal_routes_tolerance_range" CHECK ("signal_routes"."clock_tolerance_seconds" BETWEEN 0 AND 60)
);
--> statement-breakpoint
CREATE TABLE "webhook_ingress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"namespace" text NOT NULL,
	"name" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signal_decisions" ADD CONSTRAINT "signal_decisions_event_id_signal_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."signal_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_decisions" ADD CONSTRAINT "signal_decisions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_decisions" ADD CONSTRAINT "signal_decisions_order_block_id_order_blocks_id_fk" FOREIGN KEY ("order_block_id") REFERENCES "public"."order_blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_decisions" ADD CONSTRAINT "signal_decisions_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_route_id_signal_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."signal_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_package_id_strategy_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."strategy_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_routes" ADD CONSTRAINT "signal_routes_ingress_id_webhook_ingress_id_fk" FOREIGN KEY ("ingress_id") REFERENCES "public"."webhook_ingress"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_routes" ADD CONSTRAINT "signal_routes_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_routes" ADD CONSTRAINT "signal_routes_package_id_strategy_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."strategy_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_key" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_claimable_idx" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_decisions_unique_step" ON "signal_decisions" USING btree ("event_id","order_block_id","step");--> statement-breakpoint
CREATE INDEX "signal_decisions_owner_idx" ON "signal_decisions" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_events_dedupe_key" ON "signal_events" USING btree ("ingress_namespace","route_id","bar_open_at","action");--> statement-breakpoint
CREATE INDEX "signal_events_stream_idx" ON "signal_events" USING btree ("stream_key","bar_open_at");--> statement-breakpoint
CREATE INDEX "signal_rejections_received_idx" ON "signal_rejections" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_routes_tuple_key" ON "signal_routes" USING btree ("ingress_id","source_exchange","source_symbol","interval","action") WHERE "signal_routes"."enabled";--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_ingress_namespace_key" ON "webhook_ingress" USING btree ("namespace");--> statement-breakpoint
CREATE INDEX "webhook_ingress_prefix_idx" ON "webhook_ingress" USING btree ("token_prefix");