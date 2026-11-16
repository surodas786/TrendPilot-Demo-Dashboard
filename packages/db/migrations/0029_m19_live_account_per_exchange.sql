-- Bitunix Step 3: one trading account per investor, mode AND exchange (a Bitunix Live account next
-- to the MEXC Live account). The new column defaults to 'MEXC', so every existing account (Paper and
-- MEXC Live) keeps its id, balances, ledger, orders and positions and simply reads as MEXC. Paper
-- stays MEXC-only (check). (owner, mode) pairs that were unique stay unique as (owner, mode, exchange).
DROP INDEX "paper_accounts_owner_mode_key";--> statement-breakpoint
ALTER TABLE "paper_accounts" ADD COLUMN "exchange" text DEFAULT 'MEXC' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "paper_accounts_owner_mode_exchange_key" ON "paper_accounts" USING btree ("owner_id","mode","exchange");--> statement-breakpoint
ALTER TABLE "paper_accounts" ADD CONSTRAINT "paper_accounts_exchange_valid" CHECK ("paper_accounts"."exchange" IN ('MEXC', 'BITUNIX') AND ("paper_accounts"."mode" = 'LIVE' OR "paper_accounts"."exchange" = 'MEXC'));