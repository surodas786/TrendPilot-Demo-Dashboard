ALTER TABLE "market_feed_status" ADD COLUMN "quote_channel" text;--> statement-breakpoint
ALTER TABLE "market_feed_status" ADD COLUMN "last_stream_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "market_quotes" ADD COLUMN "channel" text;