ALTER TABLE "order_blocks" ADD COLUMN "trading_window_start" text;--> statement-breakpoint
ALTER TABLE "order_blocks" ADD COLUMN "trading_window_end" text;--> statement-breakpoint
ALTER TABLE "position_targets" ADD COLUMN "trigger_rule" text DEFAULT 'TOUCH' NOT NULL;--> statement-breakpoint
ALTER TABLE "position_targets" ADD COLUMN "armed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "position_targets" ADD COLUMN "armed_price" numeric(32, 12);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_planned_contracts" numeric(28, 12);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_filled_contracts" numeric(28, 12) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_blocks" ADD CONSTRAINT "order_blocks_trading_window_valid" CHECK (("order_blocks"."trading_window_start" IS NULL AND "order_blocks"."trading_window_end" IS NULL) OR ("order_blocks"."trading_window_start" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "order_blocks"."trading_window_end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "order_blocks"."trading_window_start" <> "order_blocks"."trading_window_end"));--> statement-breakpoint
ALTER TABLE "position_targets" ADD CONSTRAINT "position_targets_trigger_rule_valid" CHECK ("position_targets"."trigger_rule" IN ('TOUCH', 'ARM_PULLBACK'));--> statement-breakpoint
-- Exit allocation moves from Take Profit to Trailing Take Profit ("Position to close (%)").
-- Saved blocks with Trailing Take Profit on are converted so every block keeps exactly the split
-- it had: Trailing Take Profit gets 100% minus what the targets closed, and the targets now
-- divide the Take Profit share (100%) between them in the same proportions. Blocks with
-- trailing off are unchanged (their targets already total 100%). Open positions keep the exit
-- rules saved with them: their targets stay on the TOUCH rule and their trailing quantity stays
-- "what no target reserves" (trailing_planned_contracts is null).
UPDATE "order_blocks" SET "trailing" = "trailing" || jsonb_build_object('closePct', '100')
WHERE ("trailing"->>'enabled')::boolean IS TRUE AND "take_profit"->>'mode' = 'OFF';--> statement-breakpoint
UPDATE "order_blocks" SET
  "trailing" = "trailing" || jsonb_build_object('closePct', trim_scale(100 - ("take_profit"#>>'{levels,0,closePct}')::numeric)::text),
  "take_profit" = jsonb_set("take_profit", '{levels,0,closePct}', '"100"')
WHERE ("trailing"->>'enabled')::boolean IS TRUE AND "take_profit"->>'mode' = 'FIXED' AND jsonb_array_length("take_profit"->'levels') = 1;--> statement-breakpoint
WITH lv AS (
  SELECT b.id, l.value AS level, l.ord, (l.value->>'closePct')::numeric AS c,
         sum((l.value->>'closePct')::numeric) OVER (PARTITION BY b.id) AS total,
         count(*) OVER (PARTITION BY b.id) AS n
  FROM "order_blocks" b, jsonb_array_elements(b."take_profit"->'levels') WITH ORDINALITY AS l(value, ord)
  WHERE (b."trailing"->>'enabled')::boolean IS TRUE AND b."take_profit"->>'mode' = 'SPLIT'
),
scaled AS (
  SELECT id, ord, level, total, n, round(c * 100 / total, 8) AS share FROM lv
),
fixed AS (
  SELECT id, ord, total,
         level || jsonb_build_object('closePct', trim_scale(CASE WHEN ord = n THEN 100 - (sum(share) OVER (PARTITION BY id) - share) ELSE share END)::text) AS level
  FROM scaled
),
agg AS (
  SELECT id, max(total) AS total, jsonb_agg(level ORDER BY ord) AS levels FROM fixed GROUP BY id
)
UPDATE "order_blocks" b SET
  "take_profit" = jsonb_set(b."take_profit", '{levels}', agg.levels),
  "trailing" = b."trailing" || jsonb_build_object('closePct', trim_scale(100 - agg.total)::text)
FROM agg WHERE b.id = agg.id AND agg.total > 0 AND agg.total < 100;
--> statement-breakpoint
-- Arming is persisted and one-way: a target armed by a reached price stays armed (also across
-- worker restarts), and the rule saved with a target never changes.
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
  IF NEW.trigger_rule <> OLD.trigger_rule THEN
    RAISE EXCEPTION 'position_targets: the trigger rule saved with a target is immutable';
  END IF;
  IF OLD.armed_at IS NOT NULL AND (NEW.armed_at IS NULL OR NEW.armed_at <> OLD.armed_at) THEN
    RAISE EXCEPTION 'position_targets: an armed target stays armed';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Trailing Take Profit fills only move forward and never exceed its allocation.
ALTER TABLE "positions" ADD CONSTRAINT "positions_trailing_alloc_valid" CHECK ("trailing_filled_contracts" >= 0 AND ("trailing_planned_contracts" IS NULL OR "trailing_filled_contracts" <= "trailing_planned_contracts"));
