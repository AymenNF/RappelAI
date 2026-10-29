CREATE TABLE quota_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  requests_minute integer NOT NULL DEFAULT 60 CHECK(requests_minute BETWEEN 0 AND 10000),
  requests_day integer NOT NULL DEFAULT 1000 CHECK(requests_day BETWEEN 0 AND 1000000),
  model_minute integer NOT NULL DEFAULT 20 CHECK(model_minute BETWEEN 0 AND 10000),
  model_day integer NOT NULL DEFAULT 100 CHECK(model_day BETWEEN 0 AND 1000000),
  send_minute integer NOT NULL DEFAULT 30 CHECK(send_minute BETWEEN 0 AND 10000),
  send_day integer NOT NULL DEFAULT 200 CHECK(send_day BETWEEN 0 AND 1000000),
  global_model_day integer NOT NULL DEFAULT 10000 CHECK(global_model_day BETWEEN 0 AND 1000000),
  global_send_day integer NOT NULL DEFAULT 20000 CHECK(global_send_day BETWEEN 0 AND 1000000),
  pending_reminders integer NOT NULL DEFAULT 500 CHECK(pending_reminders BETWEEN 0 AND 100000),
  list_items integer NOT NULL DEFAULT 5000 CHECK(list_items BETWEEN 0 AND 1000000)
);
INSERT INTO quota_policy DEFAULT VALUES;
CREATE FUNCTION lock_quota_policy() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(current_schema()||':quota-policy',0));
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION lock_quota_policy() FROM PUBLIC;
CREATE TRIGGER quota_policy_lock BEFORE UPDATE ON quota_policy FOR EACH ROW EXECUTE FUNCTION lock_quota_policy();
CREATE TABLE quota_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id), blocked boolean NOT NULL DEFAULT false
);
CREATE TABLE quota_counters (
  user_id uuid NOT NULL REFERENCES users(id), metric text NOT NULL CHECK(metric IN ('requests_minute','requests_day','model_minute','model_day','send_minute','send_day','notice_minute','status_minute')),
  period timestamptz NOT NULL, used integer NOT NULL DEFAULT 0 CHECK(used>=0), PRIMARY KEY(user_id,metric,period)
);
CREATE TABLE quota_global_counters (
  metric text NOT NULL CHECK(metric IN ('global_model_day','global_send_day')),period timestamptz NOT NULL,
  used integer NOT NULL DEFAULT 0 CHECK(used>=0), PRIMARY KEY(metric,period)
);
CREATE TABLE request_admissions (
  event_id uuid PRIMARY KEY REFERENCES ingress_events(id), user_id uuid NOT NULL REFERENCES users(id),
  allowed boolean NOT NULL, reason text NOT NULL, reply_text text, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER request_admission_owner BEFORE INSERT ON request_admissions FOR EACH ROW EXECUTE FUNCTION check_identity_event_owner();
CREATE TABLE quota_operator_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor text NOT NULL DEFAULT current_user,
  note text NOT NULL CHECK(length(note) BETWEEN 1 AND 500),details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON quota_policy,quota_global_counters,quota_operator_audit FROM PUBLIC;
GRANT SELECT ON quota_policy TO memorae_worker;
GRANT SELECT,INSERT,UPDATE ON quota_global_counters TO memorae_worker;
DO $policies$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['quota_accounts','quota_counters','request_admissions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY worker_access ON %I TO memorae_worker USING(true) WITH CHECK(true)',table_name);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO memorae_tenant USING(user_id=NULLIF(current_setting(''app.user_id'',true),'''')::uuid)',table_name);
    EXECUTE format('GRANT SELECT ON %I TO memorae_worker,memorae_tenant',table_name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',table_name);
  END LOOP;
END $policies$;
GRANT INSERT,UPDATE ON quota_counters TO memorae_worker;
GRANT INSERT ON request_admissions TO memorae_worker;
CREATE INDEX work_unfinished ON work_outbox(id) WHERE status<>'completed';
