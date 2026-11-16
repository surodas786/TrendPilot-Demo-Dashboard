-- Bitunix (Step 1): one exchange connection per investor AND exchange, so a Bitunix key can sit
-- next to the MEXC key. Existing rows all carry the default exchange 'MEXC' (no code path ever
-- wrote another value), so they keep their identity and satisfy the new check. Any (owner) pair
-- that was unique stays unique as (owner, exchange); nothing is rewritten.
DROP INDEX "exchange_connections_owner_key";--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_connections_owner_exchange_key" ON "exchange_connections" USING btree ("owner_id","exchange");--> statement-breakpoint
ALTER TABLE "exchange_connections" ADD CONSTRAINT "exchange_connections_exchange_valid" CHECK ("exchange_connections"."exchange" IN ('MEXC', 'BITUNIX'));