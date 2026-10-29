CREATE TABLE reminder_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  reference text NOT NULL UNIQUE DEFAULT substr(replace(gen_random_uuid()::text,'-',''),1,16) CHECK(reference ~ '^[a-f0-9]{16}$'),
  source_reminder_id uuid NOT NULL, source_version integer NOT NULL CHECK(source_version>0),
  source_due_at timestamptz NOT NULL, cadence text NOT NULL CHECK(cadence IN ('daily','weekly')),
  until_date date NOT NULL, timezone text NOT NULL,
  consent_grant_at timestamptz NOT NULL, timezone_confirmed_at timestamptz NOT NULL,
  dst_policy text NOT NULL DEFAULT 'gap-forward-fold-first-v1' CHECK(dst_policy='gap-forward-fold-first-v1'),
  tzdb_version text NOT NULL, schedule jsonb NOT NULL CHECK(jsonb_typeof(schedule)='array' AND jsonb_array_length(schedule) BETWEEN 2 AND 366),
  status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','active','cancelled','suppressed')),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,id),
  FOREIGN KEY(user_id,source_reminder_id) REFERENCES reminders(user_id,id)
);
CREATE INDEX reminder_series_user_status ON reminder_series(user_id,status);
ALTER TABLE reminders ADD COLUMN series_id uuid;
ALTER TABLE reminders ADD COLUMN series_local_date date;
ALTER TABLE reminders ADD CONSTRAINT reminder_series_owner FOREIGN KEY(user_id,series_id) REFERENCES reminder_series(user_id,id);
ALTER TABLE reminders ADD CONSTRAINT reminder_series_date CHECK((series_id IS NULL)=(series_local_date IS NULL));
ALTER TABLE reminders ADD CONSTRAINT reminder_series_once UNIQUE(series_id,series_local_date);
GRANT UPDATE(series_id,series_local_date) ON reminders TO memorae_worker;

CREATE TABLE reminder_series_actions (
  event_id uuid PRIMARY KEY REFERENCES ingress_events(id), user_id uuid NOT NULL REFERENCES users(id),
  series_id uuid, outcome text NOT NULL CHECK(outcome IN ('proposed','confirmed','cancelled','stale','invalid')),
  reply_text text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(user_id,series_id) REFERENCES reminder_series(user_id,id)
);
CREATE TRIGGER reminder_series_event_owner BEFORE INSERT ON reminder_series_actions
  FOR EACH ROW EXECUTE FUNCTION check_identity_event_owner();
ALTER TABLE reminder_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_series FORCE ROW LEVEL SECURITY;
ALTER TABLE reminder_series_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_series_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_access ON reminder_series TO memorae_worker USING(true) WITH CHECK(true);
CREATE POLICY worker_access ON reminder_series_actions TO memorae_worker USING(true) WITH CHECK(true);
CREATE POLICY tenant_read ON reminder_series FOR SELECT TO memorae_tenant USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY tenant_read ON reminder_series_actions FOR SELECT TO memorae_tenant USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
REVOKE ALL ON reminder_series,reminder_series_actions FROM PUBLIC;
GRANT SELECT,INSERT ON reminder_series,reminder_series_actions TO memorae_worker;
GRANT UPDATE(status,updated_at) ON reminder_series TO memorae_worker;
GRANT SELECT ON reminder_series,reminder_series_actions TO memorae_tenant;
