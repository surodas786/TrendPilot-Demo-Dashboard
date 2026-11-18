ALTER TABLE "paper_accounts" DROP CONSTRAINT "paper_accounts_exchange_valid";--> statement-breakpoint
ALTER TABLE "signal_route_targets" DROP CONSTRAINT "signal_route_targets_exchange_valid";--> statement-breakpoint
ALTER TABLE "instruments" ADD COLUMN "max_notional" numeric(28, 12);--> statement-breakpoint
ALTER TABLE "paper_accounts" ADD CONSTRAINT "paper_accounts_exchange_valid" CHECK (("paper_accounts"."mode" = 'LIVE' AND "paper_accounts"."exchange" IN ('MEXC', 'BITUNIX')) OR ("paper_accounts"."mode" = 'PAPER' AND "paper_accounts"."exchange" IN ('MEXC', 'LIGHTER')));--> statement-breakpoint
ALTER TABLE "signal_route_targets" ADD CONSTRAINT "signal_route_targets_exchange_valid" CHECK ("signal_route_targets"."exchange" IN ('BITUNIX', 'LIGHTER'));