ALTER TABLE users ADD COLUMN deletion_requested_at timestamptz;
CREATE TABLE privacy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK(kind IN ('export','delete')),
  reference text NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text,'-',''),
  status text NOT NULL CHECK(status IN ('offered','requested','exported','expired')),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,id)
);
CREATE UNIQUE INDEX privacy_one_open ON privacy_requests(user_id,kind) WHERE status IN ('offered','requested');
CREATE TABLE privacy_actions (
  event_id uuid PRIMARY KEY REFERENCES ingress_events(id),user_id uuid NOT NULL REFERENCES users(id),
  reply_text text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER privacy_action_owner BEFORE INSERT ON privacy_actions FOR EACH ROW EXECUTE FUNCTION check_identity_event_owner();
DO $policies$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['privacy_requests','privacy_actions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY worker_access ON %I TO memorae_worker USING(true) WITH CHECK(true)',table_name);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO memorae_tenant USING(user_id=NULLIF(current_setting(''app.user_id'',true),'''')::uuid)',table_name);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO memorae_worker',table_name);
    EXECUTE format('GRANT SELECT ON %I TO memorae_tenant',table_name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',table_name);
  END LOOP;
END $policies$;
GRANT UPDATE(status) ON privacy_requests TO memorae_worker;

-- Reuse existing ownership FKs instead of adding new user-row locks to receipt/recovery paths.
-- Runtime roles still have no DELETE privilege on accounts or business records.
DO $erase$
DECLARE f record;
BEGIN
  FOR f IN SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND k.contype='f' AND k.confdeltype='a'
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='user_id' AND a.attnum=ANY(k.conkey)) LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',f.relname,f.conname);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s ON DELETE CASCADE',f.relname,f.conname,f.definition);
  END LOOP;
END $erase$;
ALTER TABLE usage_audit DROP CONSTRAINT usage_audit_reservation_id_fkey;
ALTER TABLE usage_audit ADD CONSTRAINT usage_audit_reservation_id_fkey FOREIGN KEY(reservation_id) REFERENCES usage_reservations(id) ON DELETE CASCADE;

-- Existing NO ACTION references remain immediate for ordinary writes. The erase transaction
-- defers their checks until every owner cascade (including cycles) has completed.
DO $defer$
DECLARE f record;
BEGIN
  FOR f IN SELECT c.relname,k.conname FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND k.contype='f' AND k.confdeltype='a' LOOP
    EXECUTE format('ALTER TABLE %I ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',f.relname,f.conname);
  END LOOP;
END $defer$;

CREATE TABLE privacy_key (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  secret text NOT NULL DEFAULT (gen_random_uuid()::text||gen_random_uuid()::text)
);
INSERT INTO privacy_key DEFAULT VALUES;
CREATE TABLE privacy_tombstones (
  fingerprint text PRIMARY KEY CHECK(length(fingerprint)=64),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE privacy_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),action text NOT NULL CHECK(action IN ('purged','retention','exported')),
  counts jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE privacy_retention (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  raw_days integer NOT NULL DEFAULT 30 CHECK(raw_days BETWEEN 1 AND 3650),
  counter_days integer NOT NULL DEFAULT 90 CHECK(counter_days BETWEEN 2 AND 3650)
);
INSERT INTO privacy_retention DEFAULT VALUES;
REVOKE ALL ON privacy_key,privacy_tombstones,privacy_operations,privacy_retention FROM PUBLIC;
CREATE FUNCTION privacy_address_blocked(phone text,sender text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $body$
  SELECT EXISTS(SELECT 1 FROM privacy_tombstones t,privacy_key k
    WHERE t.fingerprint=encode(sha256(convert_to(k.secret||jsonb_build_array(phone,sender)::text,'UTF8')),'hex'));
$body$;
REVOKE ALL ON FUNCTION privacy_address_blocked(text,text) FROM PUBLIC;
DO $path$
BEGIN
  EXECUTE format('ALTER FUNCTION privacy_address_blocked(text,text) SET search_path TO pg_catalog,%I,pg_temp',current_schema());
END $path$;
GRANT EXECUTE ON FUNCTION privacy_address_blocked(text,text) TO memorae_ingress,memorae_worker;
ALTER TABLE ingress_events ADD COLUMN redacted_at timestamptz;
