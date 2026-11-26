-- Investor Management revision (26 Nov 2026):
--  1. Trailing Take Profit per position side (trailing_long / trailing_short), converted from the
--     shared "trailing" with the same first-trigger effect. The old column stays (read-only, for
--     rollback and for position snapshots taken before this release).
--  2. Overall Take Profit allocation stored on each side's Take Profit (take_profit.allocationPct).
--  3. "Sync Admin Setting" per order block (default off) and Admin → Common Exit Definition revisions.
--  4. Partial trailing exits with persisted rearm cycles and a one-shot target close per position.
--  5. A minimal in-app notification inbox (none existed before).

ALTER TABLE "order_blocks" ADD COLUMN "trailing_long" jsonb;--> statement-breakpoint
ALTER TABLE "order_blocks" ADD COLUMN "trailing_short" jsonb;--> statement-breakpoint
ALTER TABLE "order_blocks" ADD COLUMN "sync_admin_exit" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- Conversion, per side, of the legacy shared setting (c = its "Position to close (%)" of the opening quantity):
--  - trailing off                → that side's trailing off;
--  - trailing on, side TP on     → trailing closes 100% of its pool, TP allocation = 100 - c (identical sizing);
--  - trailing on, side TP off    → trailing closes c% of the remaining quantity (first trigger identical; it may rearm);
--  - trailing on, side TP off, c = 0 → trailing off (it never closed anything);
--  - trailing on without closePct (pre-allocation rows, trailing_conversion_required) → kept enabled with
--    closePct null so the existing "convert before new entries" hold still applies.
CREATE OR REPLACE FUNCTION pg_temp.tp_lift_trailing(tr jsonb, tp jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN tr IS NULL OR COALESCE((tr->>'enabled')::boolean, false) = false
      THEN jsonb_build_object('enabled', false, 'activationPct', NULL, 'distancePct', NULL, 'closePct', NULL, 'targetClose', NULL, 'basis', COALESCE(tr->'basis', '"MARK"'::jsonb))
    WHEN COALESCE(tp->>'mode', 'OFF') = 'OFF' AND tr->>'closePct' IS NOT NULL AND (tr->>'closePct')::numeric = 0
      THEN jsonb_build_object('enabled', false, 'activationPct', NULL, 'distancePct', NULL, 'closePct', NULL, 'targetClose', NULL, 'basis', COALESCE(tr->'basis', '"MARK"'::jsonb))
    ELSE jsonb_build_object(
      'enabled', true,
      'activationPct', tr->'activationPct',
      'distancePct', tr->'distancePct',
      'closePct', CASE WHEN tr->>'closePct' IS NULL THEN NULL WHEN COALESCE(tp->>'mode', 'OFF') <> 'OFF' THEN '"100"'::jsonb ELSE tr->'closePct' END,
      'targetClose', NULL,
      'basis', COALESCE(tr->'basis', '"MARK"'::jsonb))
  END
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION pg_temp.tp_lift_allocation(tr jsonb, tp jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN tp IS NULL OR COALESCE(tp->>'mode', 'OFF') = 'OFF' OR tp ? 'allocationPct' THEN tp
    WHEN COALESCE((tr->>'enabled')::boolean, false) AND tr->>'closePct' IS NOT NULL
      THEN tp || jsonb_build_object('allocationPct', trim_scale(100 - LEAST(100, GREATEST(0, (tr->>'closePct')::numeric)))::text)
    ELSE tp || '{"allocationPct":"100"}'::jsonb
  END
$$;--> statement-breakpoint
UPDATE "order_blocks" SET
  "trailing_long" = pg_temp.tp_lift_trailing("trailing", "take_profit"),
  "trailing_short" = pg_temp.tp_lift_trailing("trailing", "take_profit_short"),
  "take_profit" = pg_temp.tp_lift_allocation("trailing", "take_profit"),
  "take_profit_short" = pg_temp.tp_lift_allocation("trailing", "take_profit_short");--> statement-breakpoint
ALTER TABLE "order_blocks" ALTER COLUMN "trailing_long" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "order_blocks" ALTER COLUMN "trailing_short" SET NOT NULL;--> statement-breakpoint
-- The legacy shared column is no longer written by new saves.
ALTER TABLE "order_blocks" ALTER COLUMN "trailing" DROP NOT NULL;--> statement-breakpoint

-- Partial trailing (positions opened after this release; trailing_close_pct NOT NULL marks them).
ALTER TABLE "positions" ADD COLUMN "trailing_close_pct" numeric(12, 8);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_cycle" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_cycle_extreme" numeric(32, 12);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_cycle_contracts" numeric(28, 12);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_cycle_filled" numeric(28, 12) NOT NULL DEFAULT '0';--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_target_price" numeric(32, 12);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_target_close_pct" numeric(12, 8);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_target_status" text;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_target_contracts" numeric(28, 12);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "trailing_target_filled" numeric(28, 12) NOT NULL DEFAULT '0';--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "exit_notice" text;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "exit_notice_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "exit_plan_source" text NOT NULL DEFAULT 'CUSTOM';--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "exit_plan_admin_version" integer;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "exit_plan_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "positions" DROP CONSTRAINT "positions_trailing_status_valid";--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_trailing_status_valid" CHECK ("positions"."trailing_status" IN ('OFF', 'WAITING', 'ACTIVE', 'REARM', 'DONE'));--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_trailing_target_status_valid" CHECK ("positions"."trailing_target_status" IS NULL OR "positions"."trailing_target_status" IN ('PENDING', 'REQUESTED', 'DONE', 'SKIPPED', 'CANCELLED'));--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_trailing_cycle_valid" CHECK ("positions"."trailing_cycle" >= 0 AND "positions"."trailing_cycle_filled" >= 0 AND ("positions"."trailing_cycle_contracts" IS NULL OR "positions"."trailing_cycle_filled" <= "positions"."trailing_cycle_contracts"));--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_exit_plan_source_valid" CHECK ("positions"."exit_plan_source" IN ('CUSTOM', 'ADMIN'));--> statement-breakpoint

-- Admin → Common Exit Definition: append-only published revisions.
CREATE TABLE "common_exit_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "version" integer NOT NULL,
  "plan" jsonb NOT NULL,
  "changes" jsonb NOT NULL,
  "scope" text NOT NULL,
  "note" text,
  "apply_result" jsonb,
  "author_id" uuid NOT NULL REFERENCES "users"("id"),
  "published_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "common_exit_definitions_scope_valid" CHECK ("scope" IN ('FUTURE_ENTRIES', 'EXISTING_POSITIONS')),
  CONSTRAINT "common_exit_definitions_version_positive" CHECK ("version" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "common_exit_definitions_version_key" ON "common_exit_definitions" ("version");--> statement-breakpoint

CREATE TABLE "user_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "data" jsonb,
  "dedupe_key" text,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "user_notifications_user_idx" ON "user_notifications" ("user_id", "created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_notifications_dedupe_key" ON "user_notifications" ("user_id", "dedupe_key") WHERE "dedupe_key" IS NOT NULL;
