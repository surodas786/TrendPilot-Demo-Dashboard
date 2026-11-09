CREATE TABLE "funding_rates" (
	"instrument_id" uuid NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"rate" numeric(18, 10) NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funding_rates_instrument_id_settled_at_pk" PRIMARY KEY("instrument_id","settled_at")
);
--> statement-breakpoint
CREATE TABLE "paper_funding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"paper_account_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"rate" numeric(18, 10) NOT NULL,
	"contracts" numeric(28, 12) NOT NULL,
	"mark_price" numeric(32, 12) NOT NULL,
	"notional" numeric(28, 8) NOT NULL,
	"amount" numeric(28, 8) NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "funding_rates" ADD CONSTRAINT "funding_rates_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_funding" ADD CONSTRAINT "paper_funding_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_funding" ADD CONSTRAINT "paper_funding_paper_account_id_paper_accounts_id_fk" FOREIGN KEY ("paper_account_id") REFERENCES "public"."paper_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_funding" ADD CONSTRAINT "paper_funding_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_funding" ADD CONSTRAINT "paper_funding_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paper_funding_once" ON "paper_funding" USING btree ("position_id","settled_at");--> statement-breakpoint
CREATE INDEX "paper_funding_owner_idx" ON "paper_funding" USING btree ("owner_id","settled_at");