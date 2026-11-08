-- M2 slice 1 guards: investor outcomes are append-only records of what was decided;
-- accepted signal events are never deleted (only their dispatch status advances).
CREATE OR REPLACE FUNCTION signal_decisions_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'signal_decisions is append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER signal_decisions_no_update_delete
  BEFORE UPDATE OR DELETE ON signal_decisions
  FOR EACH ROW EXECUTE FUNCTION signal_decisions_append_only();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION signal_events_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'signal_events rows cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.ingress_namespace, NEW.route_id, NEW.action, NEW.bar_open_at, NEW.bar_close_at, NEW.alert_fired_at, NEW.received_at, NEW.reference_price)
     IS DISTINCT FROM (OLD.ingress_namespace, OLD.route_id, OLD.action, OLD.bar_open_at, OLD.bar_close_at, OLD.alert_fired_at, OLD.received_at, OLD.reference_price) THEN
    RAISE EXCEPTION 'accepted signal content is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER signal_events_guard
  BEFORE UPDATE OR DELETE ON signal_events
  FOR EACH ROW EXECUTE FUNCTION signal_events_guard();
