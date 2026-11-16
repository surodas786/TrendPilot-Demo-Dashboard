-- Bitunix Step 4: explicit Bitunix targets for TradingView signal routes, and the per-event snapshot
-- of those targets. Additive only: existing routes have no target and existing events an empty
-- list, so every MEXC route dispatches exactly as before.
CREATE TABLE "signal_route_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"exchange" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_route_targets_exchange_valid" CHECK ("signal_route_targets"."exchange" IN ('BITUNIX'))
);
--> statement-breakpoint
ALTER TABLE "signal_events" ADD COLUMN "target_instrument_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_route_targets" ADD CONSTRAINT "signal_route_targets_route_id_signal_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."signal_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_route_targets" ADD CONSTRAINT "signal_route_targets_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signal_route_targets_route_exchange_key" ON "signal_route_targets" USING btree ("route_id","exchange");