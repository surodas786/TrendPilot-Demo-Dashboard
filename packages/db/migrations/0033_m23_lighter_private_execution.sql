CREATE SEQUENCE "public"."lighter_client_order_index_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 281474976710655 START WITH 1000 CACHE 1;--> statement-breakpoint
CREATE TABLE "lighter_nonces" (
	"environment" text NOT NULL,
	"account_index" bigint NOT NULL,
	"api_key_index" integer NOT NULL,
	"next_nonce" bigint,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"refreshed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lighter_nonces_environment_account_index_api_key_index_pk" PRIMARY KEY("environment","account_index","api_key_index"),
	CONSTRAINT "lighter_nonces_next_valid" CHECK ("lighter_nonces"."next_nonce" IS NULL OR "lighter_nonces"."next_nonce" >= 0)
);
--> statement-breakpoint
CREATE TABLE "lighter_txs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"account_index" bigint NOT NULL,
	"api_key_index" integer NOT NULL,
	"client_order_id" text NOT NULL,
	"purpose" text NOT NULL,
	"market_id" integer NOT NULL,
	"client_order_index" bigint NOT NULL,
	"stop_client_order_index" bigint,
	"nonce" bigint,
	"tx_type" integer NOT NULL,
	"tx_hash" text,
	"state" text DEFAULT 'PREPARED' NOT NULL,
	"request" jsonb NOT NULL,
	"response" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lighter_txs_purpose_valid" CHECK ("lighter_txs"."purpose" IN ('OPEN_WITH_STOP', 'CLOSE', 'STOP_RESIZE')),
	CONSTRAINT "lighter_txs_state_valid" CHECK ("lighter_txs"."state" IN ('PREPARED', 'SENDING', 'ACCEPTED', 'API_REJECTED', 'EXECUTED', 'FAILED', 'UNKNOWN')),
	CONSTRAINT "lighter_txs_client_order_index_valid" CHECK ("lighter_txs"."client_order_index" BETWEEN 1 AND 281474976710655)
);
--> statement-breakpoint
ALTER TABLE "exchange_connections" DROP CONSTRAINT "exchange_connections_exchange_valid";--> statement-breakpoint
ALTER TABLE "paper_accounts" DROP CONSTRAINT "paper_accounts_exchange_valid";--> statement-breakpoint
ALTER TABLE "exchange_connections" ADD COLUMN "venue_environment" text;--> statement-breakpoint
ALTER TABLE "exchange_connections" ADD COLUMN "venue_account_index" bigint;--> statement-breakpoint
ALTER TABLE "exchange_connections" ADD COLUMN "venue_api_key_index" integer;--> statement-breakpoint
ALTER TABLE "lighter_txs" ADD CONSTRAINT "lighter_txs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lighter_txs" ADD CONSTRAINT "lighter_txs_connection_id_exchange_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."exchange_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lighter_txs_client_order_id_key" ON "lighter_txs" USING btree ("connection_id","client_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lighter_txs_client_order_index_key" ON "lighter_txs" USING btree ("environment","account_index","client_order_index") WHERE "lighter_txs"."purpose" <> 'STOP_RESIZE';--> statement-breakpoint
CREATE INDEX "lighter_txs_key_state_idx" ON "lighter_txs" USING btree ("environment","account_index","api_key_index","state");--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_connections_lighter_account_key" ON "exchange_connections" USING btree ("venue_environment","venue_account_index") WHERE "exchange_connections"."exchange" = 'LIGHTER' AND "exchange_connections"."status" = 'VERIFIED';--> statement-breakpoint
ALTER TABLE "exchange_connections" ADD CONSTRAINT "exchange_connections_lighter_identity" CHECK ("exchange_connections"."exchange" <> 'LIGHTER' OR ("exchange_connections"."venue_environment" IN ('MAINNET', 'TESTNET') AND "exchange_connections"."venue_account_index" >= 0 AND "exchange_connections"."venue_api_key_index" BETWEEN 4 AND 254));--> statement-breakpoint
ALTER TABLE "exchange_connections" ADD CONSTRAINT "exchange_connections_exchange_valid" CHECK ("exchange_connections"."exchange" IN ('MEXC', 'BITUNIX', 'LIGHTER'));--> statement-breakpoint
ALTER TABLE "paper_accounts" ADD CONSTRAINT "paper_accounts_exchange_valid" CHECK (("paper_accounts"."mode" = 'LIVE' AND "paper_accounts"."exchange" IN ('MEXC', 'BITUNIX', 'LIGHTER')) OR ("paper_accounts"."mode" = 'PAPER' AND "paper_accounts"."exchange" IN ('MEXC', 'LIGHTER')));