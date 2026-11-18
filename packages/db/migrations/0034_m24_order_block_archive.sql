-- Order blocks can be removed by the investor (Trade Settings → Remove). A block that trade or
-- signal history references is archived (archived_at set), never deleted; the one-block-per-pair-
-- and-mode rule then applies to blocks that are not archived, so the pair can be set up again.
DROP INDEX "order_blocks_owner_instrument_mode_key";--> statement-breakpoint
ALTER TABLE "order_blocks" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "order_blocks_owner_instrument_mode_key" ON "order_blocks" USING btree ("owner_id","instrument_id","mode") WHERE "order_blocks"."archived_at" IS NULL;