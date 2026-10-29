CREATE TABLE reminder_controls (
  reference text PRIMARY KEY DEFAULT substr(replace(gen_random_uuid()::text,'-',''),1,16)
    CHECK(reference ~ '^[0-9a-f]{16}$'),
  user_id uuid NOT NULL, reminder_id uuid NOT NULL,
  schedule_version integer NOT NULL CHECK(schedule_version>0),
  consent_grant_at timestamptz NOT NULL, timezone_confirmed_at timestamptz NOT NULL,
  timezone text NOT NULL, expires_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(reminder_id,schedule_version),
  FOREIGN KEY(user_id,reminder_id) REFERENCES reminders(user_id,id)
);
CREATE TABLE reminder_mutations (
  event_id uuid PRIMARY KEY REFERENCES ingress_events(id), user_id uuid NOT NULL REFERENCES users(id),
  reminder_id uuid, action text NOT NULL CHECK(action IN ('complete','cancel','snooze','invalid')),
  outcome text NOT NULL CHECK(outcome IN ('applied','stale','invalid')),
  previous_version integer, new_version integer, reply_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(user_id,reminder_id) REFERENCES reminders(user_id,id),
  CHECK(CASE WHEN outcome='applied' THEN
    reminder_id IS NOT NULL AND previous_version IS NOT NULL AND previous_version>0
      AND new_version IS NOT NULL AND new_version=previous_version+1 AND action<>'invalid'
    ELSE reminder_id IS NULL AND previous_version IS NULL AND new_version IS NULL END)
);
CREATE TRIGGER reminder_mutation_event_owner BEFORE INSERT ON reminder_mutations
  FOR EACH ROW EXECUTE FUNCTION check_identity_event_owner();
ALTER TABLE reminder_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_controls FORCE ROW LEVEL SECURITY;
ALTER TABLE reminder_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_mutations FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_access ON reminder_controls TO memorae_worker USING(true) WITH CHECK(true);
CREATE POLICY worker_access ON reminder_mutations TO memorae_worker USING(true) WITH CHECK(true);
CREATE POLICY tenant_read ON reminder_controls FOR SELECT TO memorae_tenant
  USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY tenant_read ON reminder_mutations FOR SELECT TO memorae_tenant
  USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
REVOKE ALL ON reminder_controls,reminder_mutations FROM PUBLIC;
GRANT SELECT,INSERT ON reminder_controls,reminder_mutations TO memorae_worker;
GRANT UPDATE(invalidated_at) ON reminder_controls TO memorae_worker;
GRANT SELECT ON reminder_controls,reminder_mutations TO memorae_tenant;
GRANT UPDATE(status,due_at,schedule_version) ON reminders TO memorae_worker;
ALTER TABLE reminder_occurrences DROP CONSTRAINT reminder_occurrences_suppression_reason_check;
ALTER TABLE reminder_occurrences ADD CHECK(suppression_reason IN ('identity_changed','reminder_changed'));
ALTER TABLE outbound_messages DROP CONSTRAINT outbound_messages_suppression_reason_check;
ALTER TABLE outbound_messages ADD CHECK(suppression_reason IN ('identity_changed','reminder_changed'));
