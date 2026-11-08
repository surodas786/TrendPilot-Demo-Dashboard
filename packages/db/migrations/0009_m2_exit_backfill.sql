-- M2 slice 3: backfill rows created by slice 2 and protect exit history.
ALTER TABLE order_intents ADD CONSTRAINT order_intents_position_fk FOREIGN KEY (position_id) REFERENCES positions(id);
--> statement-breakpoint
UPDATE positions SET strategy_version_id = (settings_snapshot->'strategyVersion'->>'id')::uuid WHERE strategy_version_id IS NULL;
--> statement-breakpoint
UPDATE order_intents SET filled_contracts = contracts WHERE state = 'FILLED' AND filled_contracts = 0;
--> statement-breakpoint
-- The simulator's venue position, rebuilt from its own opening fills.
INSERT INTO sim_positions (paper_account_id, instrument_id, side, contracts)
SELECT o.paper_account_id, o.instrument_id, o.side, SUM(f.contracts)
FROM sim_orders o JOIN sim_fills f ON f.order_id = o.id
WHERE o.kind = 'MARKET_OPEN'
GROUP BY o.paper_account_id, o.instrument_id, o.side
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TRIGGER position_exits_append_only BEFORE UPDATE OR DELETE ON position_exits FOR EACH ROW EXECUTE FUNCTION paper_append_only();
