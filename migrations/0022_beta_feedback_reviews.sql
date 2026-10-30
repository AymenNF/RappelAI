CREATE TABLE beta_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id uuid NOT NULL UNIQUE REFERENCES ingress_events(id) ON DELETE CASCADE,
  category text NOT NULL CHECK(category IN ('late','missing','wrong','confusing','good','other')),
  status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','investigating','resolved')),
  resolution text CHECK(resolution IN ('fixed','duplicate','expected','not_reproducible')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,id), CHECK((status='resolved')=(resolution IS NOT NULL))
);
CREATE TRIGGER beta_feedback_owner BEFORE INSERT ON beta_feedback FOR EACH ROW EXECUTE FUNCTION check_identity_event_owner();
CREATE TABLE beta_feedback_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feedback_id uuid NOT NULL, revision integer NOT NULL, actor text NOT NULL DEFAULT current_user,
  status text NOT NULL CHECK(status IN ('new','investigating','resolved')),
  resolution text CHECK(resolution IN ('fixed','duplicate','expected','not_reproducible')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(user_id,feedback_id) REFERENCES beta_feedback(user_id,id) ON DELETE CASCADE,
  UNIQUE(feedback_id,revision)
);
DO $rls$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['beta_feedback','beta_feedback_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO memorae_tenant USING(user_id=NULLIF(current_setting(''app.user_id'',true),'''')::uuid)',tab);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',tab);
    EXECUTE format('GRANT SELECT ON %I TO memorae_tenant',tab);
  END LOOP;
END $rls$;
CREATE POLICY worker_feedback ON beta_feedback TO memorae_worker USING(true) WITH CHECK(true);
CREATE POLICY monitor_feedback ON beta_feedback FOR SELECT TO memorae_monitor USING(true);
GRANT SELECT ON beta_feedback TO memorae_worker;
GRANT INSERT(user_id,event_id,category) ON beta_feedback TO memorae_worker;
GRANT SELECT(created_at,category,status) ON beta_feedback TO memorae_monitor;
CREATE INDEX beta_feedback_queue ON beta_feedback(status,created_at,id);
CREATE INDEX beta_feedback_created ON beta_feedback(created_at);

-- Global daily settlement totals contain no account/reservation identifiers and survive erasure.
-- No historical backfill: old erased reservations cannot be reconstructed reliably.
CREATE TABLE beta_review_tracking (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),started_at timestamptz NOT NULL DEFAULT clock_timestamp());
INSERT INTO beta_review_tracking DEFAULT VALUES;
CREATE TABLE usage_daily_costs (
  day date PRIMARY KEY, settled_micros numeric(30,0) NOT NULL CHECK(settled_micros>=0),
  settled_calls bigint NOT NULL CHECK(settled_calls>=0)
);
REVOKE ALL ON beta_review_tracking,usage_daily_costs FROM PUBLIC;
GRANT SELECT ON beta_review_tracking,usage_daily_costs TO memorae_monitor;
CREATE FUNCTION record_daily_model_cost() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
BEGIN
  IF TG_OP='UPDATE' AND OLD.state='settled' THEN
    IF NEW.state IS DISTINCT FROM OLD.state OR NEW.actual_micros IS DISTINCT FROM OLD.actual_micros OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
      RAISE EXCEPTION 'Settled usage is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state='settled' THEN
    NEW.finalized_at=clock_timestamp();
    INSERT INTO usage_daily_costs(day,settled_micros,settled_calls)
      VALUES((NEW.finalized_at AT TIME ZONE 'UTC')::date,NEW.actual_micros,1)
      ON CONFLICT(day) DO UPDATE SET settled_micros=usage_daily_costs.settled_micros+EXCLUDED.settled_micros,
        settled_calls=usage_daily_costs.settled_calls+1;
  END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION record_daily_model_cost() FROM PUBLIC;
DO $path$ BEGIN
  EXECUTE format('ALTER FUNCTION record_daily_model_cost() SET search_path TO pg_catalog,%I,pg_temp',current_schema());
END $path$;
CREATE TRIGGER daily_model_cost BEFORE INSERT OR UPDATE ON usage_reservations FOR EACH ROW EXECUTE FUNCTION record_daily_model_cost();

-- Only lifecycle/timing and monetary columns; never message content, addresses or secrets.
GRANT SELECT(reserved_micros) ON usage_reservations TO memorae_monitor;
GRANT SELECT(status,occurred_at) ON whatsapp_receipts TO memorae_monitor;
GRANT SELECT(promised_due_at) ON reminders TO memorae_monitor;
CREATE INDEX beta_outbound_day ON outbound_messages(available_at);
CREATE INDEX beta_receipts_delivery_time ON whatsapp_receipts(attempt_id,occurred_at) WHERE status IN ('delivered','read');
