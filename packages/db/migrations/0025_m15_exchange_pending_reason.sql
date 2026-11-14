-- Why a closed-on-MEXC position's fills are still pending (shown to the investor).
ALTER TABLE "positions" ADD COLUMN "exchange_pending_reason" text;