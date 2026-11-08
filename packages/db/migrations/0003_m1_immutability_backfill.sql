-- M1: backfill new order-block fields, map existing published versions to their pairs,
-- then enforce CFG-02 immutability of published strategy versions in the database.

-- CFG-03: stop and trailing carry a trigger price basis; risk caps default to "platform ceiling".
UPDATE order_blocks SET stop = stop || '{"basis":"MARK"}'::jsonb WHERE NOT (stop ? 'basis');
--> statement-breakpoint
UPDATE order_blocks
SET "trailing" = jsonb_build_object(
  'enabled', COALESCE("trailing"->'enabled', 'false'::jsonb),
  'activationPct', 'null'::jsonb,
  'distancePct', COALESCE("trailing"->'distancePct', 'null'::jsonb),
  'basis', '"MARK"'::jsonb)
WHERE NOT ("trailing" ? 'basis');
--> statement-breakpoint
UPDATE order_blocks
SET risk = '{"maxOpenPositions":null,"maxNotionalUsdt":null,"maxStopRiskUsdt":null,"dailyLossLimitUsdt":null,"cooldownMinutes":null,"maxSpreadPct":null,"maxPriceDeviationPct":null}'::jsonb
WHERE risk = '{}'::jsonb;
--> statement-breakpoint
-- Fixture contract metadata for rows seeded before these columns existed.
UPDATE instruments SET exchange_symbol = replace(symbol, 'USDT', '_USDT') WHERE exchange_symbol = '';
--> statement-breakpoint
UPDATE instruments SET price_tick = 0.1 WHERE symbol = 'BTCUSDT' AND is_fixture;
--> statement-breakpoint
-- Versions published before pair mappings existed keep serving every pair already in use by
-- their order blocks, plus every published pair (so nothing that worked before breaks).
INSERT INTO strategy_version_instruments (version_id, instrument_id)
SELECT DISTINCT v.id, i.id
FROM strategy_versions v
JOIN instruments i ON i.status = 'PUBLISHED' OR i.id IN (SELECT instrument_id FROM order_blocks ob WHERE ob.strategy_version_id = v.id)
WHERE v.published_at IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION strategy_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'strategy version % is published and immutable (% rejected)', OLD.id, TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER strategy_versions_no_change_after_publish
  BEFORE UPDATE OR DELETE ON strategy_versions
  FOR EACH ROW EXECUTE FUNCTION strategy_versions_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION strategy_version_instruments_immutable() RETURNS trigger AS $$
DECLARE vid uuid;
BEGIN
  vid := CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  IF EXISTS (SELECT 1 FROM strategy_versions WHERE id = vid AND published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'pair mappings of published strategy version % are immutable', vid USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER strategy_version_instruments_no_change_after_publish
  BEFORE INSERT OR UPDATE OR DELETE ON strategy_version_instruments
  FOR EACH ROW EXECUTE FUNCTION strategy_version_instruments_immutable();
--> statement-breakpoint
-- At most one open draft per package.
CREATE UNIQUE INDEX strategy_versions_one_draft_per_package ON strategy_versions (package_id) WHERE published_at IS NULL;
