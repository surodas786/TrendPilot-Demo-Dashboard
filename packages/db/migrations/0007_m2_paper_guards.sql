-- M2 slice 2 guards: financial history is append-only; simulator fills never change.
CREATE OR REPLACE FUNCTION paper_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION paper_append_only();
--> statement-breakpoint
CREATE TRIGGER fills_append_only BEFORE UPDATE OR DELETE ON fills FOR EACH ROW EXECUTE FUNCTION paper_append_only();
--> statement-breakpoint
CREATE TRIGGER sim_fills_append_only BEFORE UPDATE OR DELETE ON sim_fills FOR EACH ROW EXECUTE FUNCTION paper_append_only();
--> statement-breakpoint
-- A paper account's balances must always equal the sum of its ledger, per bucket.
CREATE OR REPLACE VIEW paper_account_reconciliation AS
SELECT a.id AS paper_account_id,
       a.wallet_balance,
       COALESCE(SUM(l.amount) FILTER (WHERE l.bucket = 'WALLET'), 0) AS ledger_wallet,
       a.position_margin,
       COALESCE(SUM(l.amount) FILTER (WHERE l.bucket = 'POSITION_MARGIN'), 0) AS ledger_position_margin,
       a.order_reserve,
       COALESCE(SUM(l.amount) FILTER (WHERE l.bucket = 'ORDER_RESERVE'), 0) AS ledger_order_reserve
FROM paper_accounts a
LEFT JOIN ledger_entries l ON l.paper_account_id = a.id
GROUP BY a.id;
