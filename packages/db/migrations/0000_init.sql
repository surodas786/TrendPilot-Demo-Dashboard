CREATE TYPE "public"."block_status" AS ENUM('ACTIVE', 'PAUSED');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('LONG_ONLY', 'SHORT_ONLY', 'BOTH');--> statement-breakpoint
CREATE TYPE "public"."ema_filter" AS ENUM('OFF', 'EMA200');--> statement-breakpoint
CREATE TYPE "public"."instrument_status" AS ENUM('PUBLISHED', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."margin_mode" AS ENUM('ISOLATED', 'CROSS');--> statement-breakpoint
CREATE TYPE "public"."opposite_policy" AS ENUM('KEEP_OPEN', 'CLOSE_ONLY', 'CLOSE_AND_REVERSE');--> statement-breakpoint
CREATE TYPE "public"."timeframe" AS ENUM('5m', '15m');--> statement-breakpoint
CREATE TYPE "public"."trading_mode" AS ENUM('PAPER', 'LIVE');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('ADMIN', 'INVESTOR');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'SUSPENDED', 'INVITED');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"result" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exchange" text NOT NULL,
	"symbol" text NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"status" "instrument_status" DEFAULT 'DISABLED' NOT NULL,
	"contract_multiplier" numeric(28, 12) NOT NULL,
	"qty_step" numeric(28, 12) NOT NULL,
	"min_qty" numeric(28, 12) NOT NULL,
	"leverage_choices" integer[] NOT NULL,
	"suggested_stop_pct" numeric(10, 4) NOT NULL,
	"suggested_take_profit_pct" numeric(10, 4) NOT NULL,
	"suggested_trailing_enabled" boolean DEFAULT false NOT NULL,
	"suggested_trailing_pct" numeric(10, 4) NOT NULL,
	"is_fixture" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"mode" "trading_mode" NOT NULL,
	"direction" "direction" NOT NULL,
	"order_cost_usdt" numeric(28, 8) NOT NULL,
	"leverage" integer NOT NULL,
	"margin_mode" "margin_mode" NOT NULL,
	"stop" jsonb NOT NULL,
	"take_profit" jsonb NOT NULL,
	"trailing" jsonb NOT NULL,
	"weekdays" text[] DEFAULT ARRAY['SUN','MON','TUE','WED','THU','FRI','SAT']::text[] NOT NULL,
	"timezone" text DEFAULT 'Asia/Dhaka' NOT NULL,
	"allow_adds" boolean DEFAULT false NOT NULL,
	"max_adds" integer,
	"risk" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "block_status" DEFAULT 'PAUSED' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_blocks_order_cost_positive" CHECK ("order_blocks"."order_cost_usdt" > 0),
	CONSTRAINT "order_blocks_leverage_positive" CHECK ("order_blocks"."leverage" > 0),
	CONSTRAINT "order_blocks_weekdays_valid" CHECK ("order_blocks"."weekdays" <@ ARRAY['SUN','MON','TUE','WED','THU','FRI','SAT']::text[]),
	CONSTRAINT "order_blocks_max_adds_range" CHECK ("order_blocks"."max_adds" IS NULL OR ("order_blocks"."max_adds" BETWEEN 1 AND 10)),
	CONSTRAINT "order_blocks_revision_positive" CHECK ("order_blocks"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"timeframe" timeframe NOT NULL,
	"atr_length" integer NOT NULL,
	"atr_factor" numeric(10, 4) NOT NULL,
	"permitted_directions" "direction" NOT NULL,
	"ema_filter" "ema_filter" DEFAULT 'OFF' NOT NULL,
	"opposite_policy" "opposite_policy" DEFAULT 'KEEP_OPEN' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
	"password_hash" text,
	"timezone" text DEFAULT 'Asia/Dhaka' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_blocks" ADD CONSTRAINT "order_blocks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_blocks" ADD CONSTRAINT "order_blocks_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_blocks" ADD CONSTRAINT "order_blocks_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_package_id_strategy_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."strategy_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_exchange_symbol_key" ON "instruments" USING btree ("exchange","symbol");--> statement-breakpoint
CREATE UNIQUE INDEX "order_blocks_owner_instrument_mode_key" ON "order_blocks" USING btree ("owner_id","instrument_id","mode");--> statement-breakpoint
CREATE INDEX "order_blocks_owner_id_idx" ON "order_blocks" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_versions_package_version_key" ON "strategy_versions" USING btree ("package_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");