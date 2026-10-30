-- Every physical restore gets a fresh server-supplied instance UUID. An approval
-- copied inside a later backup must never release another restore automatically.
ALTER TABLE recovery_policy ADD COLUMN target_instance uuid;
CREATE OR REPLACE FUNCTION recovery_blocked() RETURNS boolean LANGUAGE sql STABLE SET search_path FROM CURRENT AS $body$
  SELECT COALESCE((SELECT quarantined OR (
    COALESCE(current_setting('memorae.recovery_target',true),'')='on' AND (
      released_at IS NULL OR target_instance IS NULL OR
      target_instance::text IS DISTINCT FROM NULLIF(current_setting('memorae.recovery_instance',true),'')
    )) FROM recovery_policy WHERE singleton),true);
$body$;
DO $path$ BEGIN
  EXECUTE format('ALTER FUNCTION recovery_blocked() SET search_path TO pg_catalog,%I,pg_temp',current_schema());
END $path$;
