ALTER TABLE "instruments" ADD COLUMN "exchange_market_id" integer;--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "min_notional" numeric(28, 12);--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_exchange_market_id_key" ON "instruments" USING btree ("exchange","exchange_market_id") WHERE "instruments"."exchange_market_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_lighter_market_id" CHECK ("instruments"."exchange" <> 'LIGHTER' OR ("instruments"."exchange_market_id" IS NOT NULL AND "instruments"."exchange_market_id" >= 0));