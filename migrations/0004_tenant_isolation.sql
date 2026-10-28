-- Requires a migration administrator with CREATEROLE. Runtime roles never own tables.
DO $roles$
DECLARE role_name text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('memorae:runtime-roles'));
  FOREACH role_name IN ARRAY ARRAY['memorae_ingress','memorae_worker','memorae_tenant'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name AND
      (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
      OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=role_name) THEN
      RAISE EXCEPTION 'Unsafe pre-existing runtime group role: %', role_name;
    END IF;
  END LOOP;
END $roles$;

CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  reply_language text NOT NULL DEFAULT 'en' CHECK (reply_language IN ('en','fr','es')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- An audit entry may only reference a message result belonging to the same user.
ALTER TABLE identity_results ADD CONSTRAINT identity_results_owner_event UNIQUE(user_id,event_id);
ALTER TABLE consent_events ADD CONSTRAINT consent_events_owner_event
  FOREIGN KEY(user_id,event_id) REFERENCES identity_results(user_id,event_id) ON DELETE CASCADE;

-- Pre-user ingress cannot use a tenant FK. Check its verified sender when the worker binds it.
CREATE FUNCTION check_identity_event_owner() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ingress_events e JOIN users u
      ON u.business_phone_id=e.phone_number_id AND u.sender_id=e.sender_id
    WHERE e.id=NEW.event_id AND e.kind='inbound.message' AND u.id=NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Identity event owner mismatch' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION check_identity_event_owner() FROM PUBLIC;
CREATE TRIGGER identity_event_owner BEFORE INSERT OR UPDATE OF user_id,event_id ON identity_results
  FOR EACH ROW EXECUTE FUNCTION check_identity_event_owner();

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE identity_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_results FORCE ROW LEVEL SECURITY;
ALTER TABLE consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_events FORCE ROW LEVEL SECURITY;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences FORCE ROW LEVEL SECURITY;

-- Missing/empty context sees no rows. Malformed context errors rather than exposing data.
CREATE POLICY tenant_users ON users TO memorae_tenant
  USING (id=NULLIF(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY tenant_results ON identity_results TO memorae_tenant
  USING (user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY tenant_consent ON consent_events TO memorae_tenant
  USING (user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY tenant_preferences ON user_preferences TO memorae_tenant
  USING (user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);

-- Explicit trusted worker policies, not BYPASSRLS. SQL grants further restrict operations.
CREATE POLICY worker_users ON users TO memorae_worker USING(true) WITH CHECK(true);
CREATE POLICY worker_results ON identity_results TO memorae_worker USING(true) WITH CHECK(true);
CREATE POLICY worker_consent ON consent_events TO memorae_worker USING(true) WITH CHECK(true);

REVOKE ALL ON users,identity_results,consent_events,user_preferences FROM PUBLIC;
GRANT SELECT,INSERT ON ingress_events,work_outbox TO memorae_ingress;
GRANT USAGE ON SEQUENCE ingress_events_sequence_no_seq TO memorae_ingress;
GRANT SELECT,UPDATE ON ingress_events,work_outbox TO memorae_worker;
GRANT SELECT,INSERT,UPDATE ON users TO memorae_worker;
GRANT SELECT,INSERT ON identity_results,consent_events TO memorae_worker;
GRANT SELECT ON users,identity_results,consent_events TO memorae_tenant;
GRANT SELECT,INSERT,UPDATE,DELETE ON user_preferences TO memorae_tenant;

DO $schema$
BEGIN
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', current_schema());
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO memorae_ingress,memorae_worker,memorae_tenant', current_schema());
END $schema$;
