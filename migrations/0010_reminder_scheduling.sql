ALTER TABLE reminders ADD COLUMN schedule_version integer NOT NULL DEFAULT 1 CHECK(schedule_version>0);
ALTER TABLE reminders ADD COLUMN scheduled_at timestamptz;
ALTER TABLE reminders ADD CONSTRAINT reminders_owner_id UNIQUE(user_id,id);
CREATE INDEX reminders_unscheduled_due ON reminders(user_id,due_at,id)
  WHERE status='pending' AND scheduled_at IS NULL;

CREATE TABLE reminder_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, reminder_id uuid NOT NULL,
  schedule_version integer NOT NULL CHECK(schedule_version>0),
  original_due_at timestamptz NOT NULL,
  promised_due_at timestamptz NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','suppressed')),
  suppression_reason text CHECK(suppression_reason='identity_changed'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(reminder_id,schedule_version,original_due_at), UNIQUE(user_id,id),
  FOREIGN KEY(user_id,reminder_id) REFERENCES reminders(user_id,id),
  CHECK(promised_due_at=original_due_at),
  CHECK((status='suppressed')=(suppression_reason IS NOT NULL))
);

CREATE TABLE outbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, occurrence_id uuid NOT NULL UNIQUE,
  kind text NOT NULL DEFAULT 'reminder' CHECK(kind='reminder'),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4096),
  available_at timestamptz NOT NULL,
  consent_grant_at timestamptz NOT NULL,
  timezone_confirmed_at timestamptz NOT NULL, timezone text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','suppressed')),
  suppression_reason text CHECK(suppression_reason='identity_changed'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,id),
  FOREIGN KEY(user_id,occurrence_id) REFERENCES reminder_occurrences(user_id,id),
  CHECK((status='suppressed')=(suppression_reason IS NOT NULL))
);
CREATE INDEX outbound_messages_pending ON outbound_messages(available_at,id) WHERE status='pending';
CREATE INDEX outbound_messages_user_pending ON outbound_messages(user_id) WHERE status='pending';

DO $policies$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['reminder_occurrences','outbound_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY worker_access ON %I TO memorae_worker USING(true) WITH CHECK(true)',table_name);
    EXECUTE format('CREATE POLICY tenant_read ON %I TO memorae_tenant USING(user_id=NULLIF(current_setting(''app.user_id'',true),'''')::uuid)',table_name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',table_name);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO memorae_worker',table_name);
    EXECUTE format('GRANT SELECT ON %I TO memorae_tenant',table_name);
    EXECUTE format('GRANT UPDATE(status,suppression_reason) ON %I TO memorae_worker',table_name);
  END LOOP;
END $policies$;
GRANT UPDATE(scheduled_at) ON reminders TO memorae_worker;
