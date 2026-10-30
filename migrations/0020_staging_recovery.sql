DO $role$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('memorae:runtime-roles'));
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='memorae_monitor') THEN
    CREATE ROLE memorae_monitor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='memorae_monitor' AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='memorae_monitor') THEN
    RAISE EXCEPTION 'Unsafe monitor role';
  END IF;
END $role$;
GRANT USAGE ON SCHEMA public TO memorae_monitor;
DO $schema$ BEGIN EXECUTE format('GRANT USAGE ON SCHEMA %I TO memorae_monitor',current_schema()); END $schema$;
GRANT SELECT ON telemetry_runtime,telemetry_counters,telemetry_batches,monitoring_policy,monitoring_snapshot,monitoring_alerts,monitoring_events TO memorae_monitor;
GRANT INSERT,UPDATE ON monitoring_snapshot,monitoring_alerts TO memorae_monitor;
GRANT INSERT,DELETE ON monitoring_events TO memorae_monitor;
GRANT DELETE ON telemetry_counters,telemetry_batches TO memorae_monitor;
GRANT UPDATE(expect_api,expect_worker) ON monitoring_policy TO memorae_monitor;
GRANT USAGE,SELECT ON SEQUENCE monitoring_events_sequence_seq TO memorae_monitor;
GRANT SELECT(id,created_at,stage,status,available_at,lease_until) ON work_outbox TO memorae_monitor;
GRANT SELECT(id,deletion_requested_at) ON users TO memorae_monitor;
GRANT SELECT(id,state,created_at) ON usage_reservations TO memorae_monitor;
GRANT SELECT(enabled,global_monthly_micros,singleton) ON usage_policy TO memorae_monitor;
GRANT SELECT ON usage_global_periods TO memorae_monitor;
GRANT SELECT(id,created_at,state,delivery_status,recovery_state,dispatch_deadline,outbound_message_id) ON whatsapp_attempts TO memorae_monitor;
GRANT SELECT(attempt_id,action,created_at) ON delivery_recovery_audit TO memorae_monitor;
GRANT SELECT(status,scheduled_at,due_at) ON reminders TO memorae_monitor;
GRANT SELECT(id,status,available_at) ON outbound_messages TO memorae_monitor;
GRANT SELECT(event_id,created_at,attempt_id) ON whatsapp_receipts TO memorae_monitor;
DO $rls$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['users','usage_reservations','whatsapp_attempts','delivery_recovery_audit','reminders','outbound_messages','whatsapp_receipts'] LOOP
    EXECUTE format('CREATE POLICY monitor_read ON %I FOR SELECT TO memorae_monitor USING(true)',tab);
  END LOOP;
END $rls$;

CREATE TABLE recovery_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), quarantined boolean NOT NULL DEFAULT false,
  session_id uuid, overlay_at timestamptz, quarantined_at timestamptz, released_at timestamptz
);
INSERT INTO recovery_policy DEFAULT VALUES;
CREATE TABLE recovery_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),session_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('quarantined','released')),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON recovery_policy,recovery_audit FROM PUBLIC;
GRANT SELECT ON recovery_policy TO memorae_ingress,memorae_worker,memorae_monitor;
CREATE FUNCTION recovery_blocked() RETURNS boolean LANGUAGE sql STABLE SET search_path FROM CURRENT AS $body$
  SELECT COALESCE((SELECT quarantined OR (COALESCE(current_setting('memorae.recovery_target',true),'')='on' AND released_at IS NULL)
  FROM recovery_policy WHERE singleton),true);
$body$;
REVOKE ALL ON FUNCTION recovery_blocked() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recovery_blocked() TO memorae_ingress,memorae_worker,memorae_monitor;

CREATE FUNCTION component_healthy(component text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $body$
BEGIN
  IF component NOT IN ('api','worker') OR NOT pg_has_role(session_user,CASE component WHEN 'api' THEN 'memorae_ingress' ELSE 'memorae_worker' END,'MEMBER') THEN
    RAISE EXCEPTION 'Component denied' USING ERRCODE='42501';
  END IF;
  RETURN NOT recovery_blocked() AND EXISTS(SELECT 1 FROM telemetry_runtime r WHERE r.component=$1 AND heartbeat_at>clock_timestamp()-interval '120 seconds');
END $body$;
REVOKE ALL ON FUNCTION component_healthy(text) FROM PUBLIC;
DO $path$ BEGIN
  EXECUTE format('ALTER FUNCTION recovery_blocked() SET search_path TO pg_catalog,%I,pg_temp',current_schema());
  EXECUTE format('ALTER FUNCTION component_healthy(text) SET search_path TO pg_catalog,%I,pg_temp',current_schema());
END $path$;
GRANT EXECUTE ON FUNCTION component_healthy(text) TO memorae_ingress,memorae_worker;
CREATE FUNCTION guard_recovery_enable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF NEW.enabled AND recovery_blocked() THEN RAISE EXCEPTION 'Restore quarantine blocks spending'; END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION guard_recovery_enable() FROM PUBLIC;
CREATE TRIGGER recovery_spend_guard BEFORE UPDATE ON usage_policy FOR EACH ROW EXECUTE FUNCTION guard_recovery_enable();
