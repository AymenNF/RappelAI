CREATE TABLE backup_monitoring_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), enabled boolean NOT NULL DEFAULT false,
  max_backup_age_seconds integer NOT NULL DEFAULT 90000 CHECK(max_backup_age_seconds BETWEEN 3600 AND 604800),
  max_backup_duration_seconds integer NOT NULL DEFAULT 3600 CHECK(max_backup_duration_seconds BETWEEN 60 AND 86400),
  max_archive_wait_seconds integer NOT NULL DEFAULT 300 CHECK(max_archive_wait_seconds BETWEEN 60 AND 3600)
);
INSERT INTO backup_monitoring_policy DEFAULT VALUES;
CREATE TABLE backup_policy_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), enabled boolean NOT NULL,
  actor text NOT NULL DEFAULT current_user, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE backup_runs (
  id uuid PRIMARY KEY, backup_name text NOT NULL UNIQUE CHECK(backup_name ~ '^base-[0-9TZ-]+-[a-f0-9]{8}$'),
  state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','verified','failed')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  manifest_verified boolean NOT NULL DEFAULT false, wal_archived boolean NOT NULL DEFAULT false,
  error_code text CHECK(error_code IN ('backup_failed','manifest_failed','archive_timeout','evidence_failed','interrupted')),
  CHECK((state='running')=(finished_at IS NULL)),
  CHECK((state='failed')=(error_code IS NOT NULL)),
  CHECK(state<>'verified' OR (manifest_verified AND wal_archived)),
  CHECK(finished_at IS NULL OR finished_at>=started_at)
);
CREATE INDEX backup_runs_started ON backup_runs(started_at DESC);
CREATE INDEX backup_runs_verified ON backup_runs(finished_at DESC) WHERE state='verified';
REVOKE ALL ON backup_monitoring_policy,backup_policy_audit,backup_runs FROM PUBLIC;

-- No caller-supplied paths, filenames, or settings. Only aggregate archive health escapes.
-- Some managed PostgreSQL services deny this probe: return unavailable, never healthy.
CREATE FUNCTION backup_archive_probe() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE waiting bigint; oldest double precision; failed boolean;
BEGIN
  SELECT count(*),COALESCE(GREATEST(0,extract(epoch FROM clock_timestamp()-min(modification))),0)
    INTO waiting,oldest FROM pg_catalog.pg_ls_archive_statusdir() WHERE name LIKE '%.ready';
  SELECT last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time>last_archived_time)
    INTO failed FROM pg_catalog.pg_stat_archiver;
  RETURN jsonb_build_object('available',true,'archiveMode',current_setting('archive_mode'),
    'pendingCount',waiting,'oldestPendingSeconds',oldest,'failureOutstanding',COALESCE(failed,false));
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('available',false);
END $body$;
REVOKE ALL ON FUNCTION backup_archive_probe() FROM PUBLIC;

CREATE FUNCTION backup_observation() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE p backup_monitoring_policy; latest backup_runs; verified_at timestamptz; probe jsonb;
  at_time timestamptz:=clock_timestamp(); overdue integer:=0; failed integer:=0; stalled integer:=0;
  disabled integer:=0; archive_failed integer:=0; archive_stalled integer:=0; unavailable integer:=0;
BEGIN
  SELECT * INTO STRICT p FROM backup_monitoring_policy WHERE singleton;
  SELECT * INTO latest FROM backup_runs ORDER BY started_at DESC,id DESC LIMIT 1;
  SELECT max(finished_at) INTO verified_at FROM backup_runs WHERE state='verified';
  IF p.enabled THEN
    overdue:=CASE WHEN verified_at IS NULL OR verified_at<=at_time-p.max_backup_age_seconds*interval '1 second' THEN 1 ELSE 0 END;
    failed:=CASE WHEN EXISTS(SELECT 1 FROM backup_runs WHERE state='failed' AND (verified_at IS NULL OR finished_at>verified_at)) THEN 1 ELSE 0 END;
    stalled:=CASE WHEN EXISTS(SELECT 1 FROM backup_runs WHERE state='running' AND started_at<=at_time-p.max_backup_duration_seconds*interval '1 second') THEN 1 ELSE 0 END;
    probe:=backup_archive_probe();
    IF COALESCE((probe->>'available')::boolean,false) THEN
      disabled:=CASE WHEN probe->>'archiveMode' IN ('on','always') THEN 0 ELSE 1 END;
      archive_failed:=CASE WHEN (probe->>'failureOutstanding')::boolean THEN 1 ELSE 0 END;
      archive_stalled:=CASE WHEN (probe->>'pendingCount')::bigint>0 AND (probe->>'oldestPendingSeconds')::double precision>=p.max_archive_wait_seconds THEN 1 ELSE 0 END;
    ELSE unavailable:=1;
    END IF;
  END IF;
  RETURN jsonb_build_object('enabled',p.enabled,'lastVerifiedAt',verified_at,'latestAttemptAt',latest.started_at,
    'latestState',latest.state,'maxBackupAgeSeconds',p.max_backup_age_seconds,
    'maxBackupDurationSeconds',p.max_backup_duration_seconds,'maxArchiveWaitSeconds',p.max_archive_wait_seconds,
    'archive',probe,'storageScope','local_only','offsiteVerified',false,
    'signals',jsonb_build_object('backup_overdue',overdue,'backup_failed',failed,'backup_stalled',stalled,
      'archive_disabled',disabled,'archive_failed',archive_failed,'archive_stalled',archive_stalled,'backup_probe_failed',unavailable));
END $body$;
REVOKE ALL ON FUNCTION backup_observation() FROM PUBLIC;
DO $path$ BEGIN
  EXECUTE format('ALTER FUNCTION backup_observation() SET search_path TO pg_catalog,%I,pg_temp',current_schema());
END $path$;
GRANT EXECUTE ON FUNCTION backup_observation() TO memorae_monitor;
