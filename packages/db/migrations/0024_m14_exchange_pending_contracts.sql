-- Contracts closed on MEXC whose fills are not booked yet (a position MEXC no longer holds is closed
-- at once; price, fees and realized P&L are backfilled from the fills later).
ALTER TABLE "positions" ADD COLUMN "exchange_pending_contracts" numeric(28, 12);