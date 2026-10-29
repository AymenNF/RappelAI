CREATE TABLE delivery_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id), revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  digest_minute integer CHECK(digest_minute BETWEEN 0 AND 1439),
  quiet_start integer CHECK(quiet_start BETWEEN 0 AND 1439), quiet_end integer CHECK(quiet_end BETWEEN 0 AND 1439),
  consent_grant_at timestamptz NOT NULL, timezone_confirmed_at timestamptz NOT NULL, timezone text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  CHECK((quiet_start IS NULL)=(quiet_end IS NULL)), CHECK(quiet_start<>quiet_end)
);
CREATE TABLE delivery_choices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
  reference text NOT NULL UNIQUE DEFAULT substr(replace(gen_random_uuid()::text,'-',''),1,16) CHECK(reference ~ '^[a-f0-9]{16}$'),
  reminder_id uuid NOT NULL, schedule_version integer NOT NULL CHECK(schedule_version>0),
  preference_revision integer NOT NULL CHECK(preference_revision>0),
  mode text NOT NULL CHECK(mode IN ('exact','digest','quiet')),
  original_due_at timestamptz NOT NULL, promised_due_at timestamptz NOT NULL,
  consent_grant_at timestamptz NOT NULL, timezone_confirmed_at timestamptz NOT NULL, timezone text NOT NULL,
  tzdb_version text NOT NULL, preference_snapshot jsonb NOT NULL CHECK(jsonb_typeof(preference_snapshot)='object'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','consumed','invalidated')),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
  FOREIGN KEY(user_id,reminder_id) REFERENCES reminders(user_id,id), UNIQUE(user_id,id),
  CHECK(promised_due_at>=original_due_at), CHECK(mode<>'exact' OR promised_due_at=original_due_at)
);
CREATE INDEX delivery_choices_pending ON delivery_choices(user_id) WHERE status='pending';
CREATE TABLE delivery_preference_actions (
  event_id uuid PRIMARY KEY REFERENCES ingress_events(id), user_id uuid NOT NULL REFERENCES users(id),
  choice_id uuid, outcome text NOT NULL CHECK(outcome IN ('shown','updated','proposed','confirmed','stale','invalid')),
  reply_text text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(user_id,choice_id) REFERENCES delivery_choices(user_id,id)
);
CREATE TRIGGER delivery_preference_event_owner BEFORE INSERT ON delivery_preference_actions
  FOR EACH ROW EXECUTE FUNCTION check_identity_event_owner();
DO $policies$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['delivery_preferences','delivery_choices','delivery_preference_actions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY worker_access ON %I TO memorae_worker USING(true) WITH CHECK(true)',table_name);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO memorae_tenant USING(user_id=NULLIF(current_setting(''app.user_id'',true),'''')::uuid)',table_name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',table_name);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO memorae_worker',table_name);
    EXECUTE format('GRANT SELECT ON %I TO memorae_tenant',table_name);
  END LOOP;
END $policies$;
GRANT UPDATE(revision,digest_minute,quiet_start,quiet_end,consent_grant_at,timezone_confirmed_at,timezone,active) ON delivery_preferences TO memorae_worker;
GRANT UPDATE(status) ON delivery_choices TO memorae_worker;
ALTER TABLE reminders DROP CONSTRAINT reminders_delivery_mode_check;
ALTER TABLE reminders ADD CHECK(delivery_mode IN ('immediate','digest','quiet'));
ALTER TABLE reminders ADD COLUMN promised_due_at timestamptz;
ALTER TABLE reminders ADD COLUMN delivery_choice_id uuid;
ALTER TABLE reminders ADD FOREIGN KEY(user_id,delivery_choice_id) REFERENCES delivery_choices(user_id,id);
ALTER TABLE reminders ADD CHECK((delivery_mode='immediate' AND promised_due_at IS NULL AND delivery_choice_id IS NULL)
  OR (delivery_mode IN ('digest','quiet') AND promised_due_at>=due_at AND promised_due_at IS NOT NULL AND delivery_choice_id IS NOT NULL));
GRANT UPDATE(delivery_mode,promised_due_at,delivery_choice_id) ON reminders TO memorae_worker;
ALTER TABLE reminder_occurrences DROP CONSTRAINT reminder_occurrences_check;
ALTER TABLE reminder_occurrences ADD COLUMN delivery_mode text NOT NULL DEFAULT 'immediate' CHECK(delivery_mode IN ('immediate','digest','quiet'));
ALTER TABLE reminder_occurrences ADD CHECK(promised_due_at>=original_due_at AND (delivery_mode<>'immediate' OR promised_due_at=original_due_at));
