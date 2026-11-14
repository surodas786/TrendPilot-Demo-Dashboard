-- One private MEXC sync per Live account at a time (worker, admin and investor button).
ALTER TABLE "exchange_connections" ADD COLUMN "sync_lease_until" timestamp with time zone;