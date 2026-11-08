CREATE TABLE "position_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"level_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"move_pct" numeric(10, 4) NOT NULL,
	"close_pct" numeric(10, 4) NOT NULL,
	"trigger_price" numeric(32, 12) NOT NULL,
	"trigger_basis" text NOT NULL,
	"planned_contracts" numeric(28, 12) NOT NULL,
	"requested_contracts" numeric(28, 12) DEFAULT '0' NOT NULL,
	"filled_contracts" numeric(28, 12) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "position_targets_status_valid" CHECK ("position_targets"."status" IN ('PENDING', 'REQUESTED', 'PARTIAL', 'DONE', 'CANCELLED')),
	CONSTRAINT "position_targets_quantities" CHECK ("position_targets"."planned_contracts" >= 0 AND "position_targets"."requested_contracts" >= 0 AND "position_targets"."filled_contracts" >= 0 AND "position_targets"."filled_contracts" <= "position_targets"."planned_contracts")
);
--> statement-breakpoint
ALTER TABLE "order_intents" ADD COLUMN "target_level_id" text;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_status" text DEFAULT 'OFF' NOT NULL;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_basis" text;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_distance_pct" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_activation_price" numeric(32, 12);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_watermark" numeric(32, 12);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_stop_price" numeric(32, 12);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "position_targets" ADD CONSTRAINT "position_targets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_targets" ADD CONSTRAINT "position_targets_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "position_targets_level_key" ON "position_targets" USING btree ("position_id","level_id");--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_trailing_status_valid" CHECK ("positions"."trailing_status" IN ('OFF', 'WAITING', 'ACTIVE'));--> statement-breakpoint
-- EXT-03: target progress only moves forward; a completed target never reopens.
CREATE OR REPLACE FUNCTION position_targets_forward_only() RETURNS trigger AS $$
BEGIN
  IF NEW.filled_contracts < OLD.filled_contracts OR NEW.requested_contracts < OLD.requested_contracts THEN
    RAISE EXCEPTION 'position_targets: filled and requested quantities never decrease';
  END IF;
  IF OLD.status = 'DONE' AND NEW.status <> 'DONE' THEN
    RAISE EXCEPTION 'position_targets: a completed target cannot reopen';
  END IF;
  IF NEW.level_id <> OLD.level_id OR NEW.planned_contracts <> OLD.planned_contracts OR NEW.trigger_price <> OLD.trigger_price THEN
    RAISE EXCEPTION 'position_targets: level ID, planned quantity and trigger are immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER position_targets_forward_only BEFORE UPDATE ON position_targets FOR EACH ROW EXECUTE FUNCTION position_targets_forward_only();
--> statement-breakpoint
-- EXT-04: the trailing level only tightens (Long: up, Short: down).
CREATE OR REPLACE FUNCTION positions_trailing_tighten_only() RETURNS trigger AS $$
BEGIN
  IF OLD.trailing_stop_price IS NOT NULL AND (NEW.trailing_stop_price IS NULL OR
     (NEW.side = 'LONG' AND NEW.trailing_stop_price < OLD.trailing_stop_price) OR
     (NEW.side = 'SHORT' AND NEW.trailing_stop_price > OLD.trailing_stop_price)) THEN
    RAISE EXCEPTION 'positions: the trailing stop level only tightens';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER positions_trailing_tighten_only BEFORE UPDATE ON positions FOR EACH ROW EXECUTE FUNCTION positions_trailing_tighten_only();
