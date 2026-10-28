-- All amounts are integer USD microdollars (1 USD = 1,000,000 micros).
CREATE TABLE usage_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  global_monthly_micros bigint NOT NULL DEFAULT 0 CHECK(global_monthly_micros>=0),
  default_user_monthly_micros bigint NOT NULL DEFAULT 0 CHECK(default_user_monthly_micros>=0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO usage_policy(singleton) VALUES(true);
CREATE TABLE usage_user_limits (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  monthly_micros bigint NOT NULL CHECK(monthly_micros>=0)
);
CREATE TABLE model_rate_cards (
  provider text NOT NULL, model text NOT NULL, version text NOT NULL,
  input_micros_per_million bigint NOT NULL CHECK(input_micros_per_million>=0),
  output_micros_per_million bigint NOT NULL CHECK(output_micros_per_million>=0),
  max_input_tokens integer NOT NULL CHECK(max_input_tokens BETWEEN 1 AND 1000000),
  max_output_tokens integer NOT NULL CHECK(max_output_tokens BETWEEN 1 AND 1000000),
  effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(provider,model,version)
);
CREATE UNIQUE INDEX active_model_rate ON model_rate_cards(provider,model) WHERE active;
CREATE TABLE usage_global_periods (
  period date PRIMARY KEY,
  reserved_micros bigint NOT NULL DEFAULT 0 CHECK(reserved_micros>=0),
  spent_micros bigint NOT NULL DEFAULT 0 CHECK(spent_micros>=0)
);
CREATE TABLE usage_user_periods (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, period date NOT NULL,
  reserved_micros bigint NOT NULL DEFAULT 0 CHECK(reserved_micros>=0),
  spent_micros bigint NOT NULL DEFAULT 0 CHECK(spent_micros>=0),
  PRIMARY KEY(user_id,period)
);
ALTER TABLE work_outbox ADD CONSTRAINT work_outbox_id_event UNIQUE(id,event_id);
CREATE TABLE usage_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id uuid NOT NULL,
  event_id uuid NOT NULL, user_id uuid NOT NULL, lease_token uuid NOT NULL,
  period date NOT NULL REFERENCES usage_global_periods(period),
  provider text NOT NULL, model text NOT NULL, rate_version text NOT NULL,
  input_rate bigint NOT NULL CHECK(input_rate>=0), output_rate bigint NOT NULL CHECK(output_rate>=0),
  max_input_tokens integer NOT NULL CHECK(max_input_tokens BETWEEN 1 AND 1000000),
  max_output_tokens integer NOT NULL CHECK(max_output_tokens BETWEEN 1 AND 1000000),
  reserved_micros bigint NOT NULL CHECK(reserved_micros>=0),
  actual_micros bigint CHECK(actual_micros>=0),
  input_tokens integer CHECK(input_tokens>=0), output_tokens integer CHECK(output_tokens>=0),
  state text NOT NULL CHECK(state IN ('reserved','dispatched','unknown','settled','released')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatched_at timestamptz, finalized_at timestamptz,
  UNIQUE(work_id,lease_token),
  FOREIGN KEY(work_id,event_id) REFERENCES work_outbox(id,event_id),
  FOREIGN KEY(user_id,event_id) REFERENCES identity_results(user_id,event_id),
  FOREIGN KEY(user_id,period) REFERENCES usage_user_periods(user_id,period),
  CHECK((state='settled')=(actual_micros IS NOT NULL))
);
CREATE INDEX unresolved_usage ON usage_reservations(event_id) WHERE state IN ('reserved','dispatched','unknown');
CREATE TABLE usage_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid REFERENCES usage_reservations(id),
  action text NOT NULL,
  actor text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE usage_user_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_user_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_user_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_user_periods FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_usage_limits ON usage_user_limits TO memorae_worker USING(true);
CREATE POLICY worker_usage_periods ON usage_user_periods TO memorae_worker USING(true) WITH CHECK(true);
CREATE POLICY worker_usage_reservations ON usage_reservations TO memorae_worker USING(true) WITH CHECK(true);
CREATE POLICY tenant_usage_limits ON usage_user_limits TO memorae_tenant
  USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY tenant_usage_periods ON usage_user_periods TO memorae_tenant
  USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY tenant_usage_reservations ON usage_reservations TO memorae_tenant
  USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
REVOKE ALL ON usage_policy,usage_user_limits,model_rate_cards,usage_global_periods,usage_user_periods,usage_reservations,usage_audit FROM PUBLIC;
GRANT SELECT ON usage_policy,usage_user_limits,model_rate_cards TO memorae_worker;
-- Workers can turn spending OFF on an overrun, never turn it on or raise limits.
GRANT UPDATE(enabled,updated_at) ON usage_policy TO memorae_worker;
CREATE FUNCTION guard_usage_enable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF NEW.enabled AND NOT OLD.enabled AND pg_has_role(current_user,'memorae_worker','MEMBER')
    AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    RAISE EXCEPTION 'Worker cannot enable spending' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION guard_usage_enable() FROM PUBLIC;
CREATE TRIGGER usage_enable_guard BEFORE UPDATE ON usage_policy FOR EACH ROW EXECUTE FUNCTION guard_usage_enable();
GRANT SELECT,INSERT,UPDATE ON usage_global_periods,usage_user_periods,usage_reservations TO memorae_worker;
GRANT SELECT,INSERT ON usage_audit TO memorae_worker;
GRANT SELECT ON usage_user_limits,usage_user_periods,usage_reservations TO memorae_tenant;
