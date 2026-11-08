CREATE TYPE "public"."session_stage" AS ENUM('ACTIVE', 'MFA_PENDING');--> statement-breakpoint
CREATE TYPE "public"."token_kind" AS ENUM('INVITE', 'RESET');--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"template" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_version_instruments" (
	"version_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	CONSTRAINT "strategy_version_instruments_version_id_instrument_id_pk" PRIMARY KEY("version_id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "user_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "token_kind" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "max_qty" numeric(28, 12) DEFAULT '1000000' NOT NULL;--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "price_tick" numeric(28, 12) DEFAULT '0.01' NOT NULL;--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "taker_fee_rate" numeric(10, 8) DEFAULT '0.0004' NOT NULL;--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "exchange_symbol" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "stage" "session_stage" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD COLUMN "signal_max_age_seconds" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD COLUMN "max_price_deviation_pct" numeric(10, 4) DEFAULT '0.5' NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD COLUMN "published_by" uuid;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_secret_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_pending_secret_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_last_step" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invited_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_version_instruments" ADD CONSTRAINT "strategy_version_instruments_version_id_strategy_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_version_instruments" ADD CONSTRAINT "strategy_version_instruments_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_tokens_token_hash_key" ON "user_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_tokens_user_idx" ON "user_tokens" USING btree ("user_id","kind");