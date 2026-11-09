CREATE TABLE "live_pilots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"investor_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"exchange_account_ref" text NOT NULL,
	"max_order_contracts" numeric(28, 12) NOT NULL,
	"max_order_notional_usdt" numeric(28, 8) NOT NULL,
	"max_leverage" integer NOT NULL,
	"max_exposure_usdt" numeric(28, 8) NOT NULL,
	"allow_adds" boolean DEFAULT false NOT NULL,
	"allow_reversal" boolean DEFAULT false NOT NULL,
	"checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"investor_activated_at" timestamp with time zone,
	"entries_halted" boolean DEFAULT false NOT NULL,
	"halt_reason" text,
	"halted_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "live_pilots_status_valid" CHECK ("live_pilots"."status" IN ('DRAFT', 'APPROVED', 'ACTIVE', 'ENDED')),
	CONSTRAINT "live_pilots_no_adds_or_reversal" CHECK ("live_pilots"."allow_adds" = false AND "live_pilots"."allow_reversal" = false),
	CONSTRAINT "live_pilots_limits_positive" CHECK ("live_pilots"."max_order_contracts" > 0 AND "live_pilots"."max_order_notional_usdt" > 0 AND "live_pilots"."max_exposure_usdt" > 0 AND "live_pilots"."max_leverage" BETWEEN 1 AND 20)
);
--> statement-breakpoint
ALTER TABLE "live_pilots" ADD CONSTRAINT "live_pilots_investor_id_users_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_pilots" ADD CONSTRAINT "live_pilots_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_pilots" ADD CONSTRAINT "live_pilots_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_pilots" ADD CONSTRAINT "live_pilots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "live_pilots_one_open" ON "live_pilots" USING btree ((true)) WHERE "live_pilots"."status" <> 'ENDED';