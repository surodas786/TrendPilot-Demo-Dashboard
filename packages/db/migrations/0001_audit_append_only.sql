-- OPS-04 / SRS §10: audit events are append-only. Reject UPDATE and DELETE at the database
-- level so no code path can rewrite history. (Test-only TRUNCATE in resetDatabase is unaffected.)
CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
--> statement-breakpoint
-- A weekday set holds at most the seven distinct codes.
ALTER TABLE order_blocks ADD CONSTRAINT order_blocks_weekdays_max CHECK (cardinality(weekdays) <= 7);
