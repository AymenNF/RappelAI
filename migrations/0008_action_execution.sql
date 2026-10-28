ALTER TABLE action_plans ADD CONSTRAINT action_plans_owner_version UNIQUE(user_id,event_id,version);

CREATE TABLE lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  name_key text NOT NULL CHECK(length(name_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,name_key), UNIQUE(user_id,id)
);
CREATE TABLE reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  source_event_id uuid NOT NULL, plan_version integer NOT NULL,
  action_key text NOT NULL UNIQUE CHECK(action_key ~ '^[a-f0-9]{64}$'),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  due_at timestamptz NOT NULL, timezone text NOT NULL,
  delivery_mode text NOT NULL CHECK(delivery_mode='immediate'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','cancelled','completed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,action_key,id),
  FOREIGN KEY(user_id,source_event_id,plan_version) REFERENCES action_plans(user_id,event_id,version)
);
CREATE INDEX reminders_due ON reminders(due_at) WHERE status='pending';
CREATE TABLE list_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, list_id uuid NOT NULL,
  source_event_id uuid NOT NULL, plan_version integer NOT NULL,
  action_key text NOT NULL UNIQUE CHECK(action_key ~ '^[a-f0-9]{64}$'),
  text text NOT NULL CHECK(length(text) BETWEEN 1 AND 1000),
  position integer NOT NULL CHECK(position>0),
  completed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,action_key,id), UNIQUE(list_id,position),
  FOREIGN KEY(user_id,list_id) REFERENCES lists(user_id,id),
  FOREIGN KEY(user_id,source_event_id,plan_version) REFERENCES action_plans(user_id,event_id,version)
);
CREATE TABLE action_receipts (
  action_key text PRIMARY KEY CHECK(action_key ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL, event_id uuid NOT NULL, plan_version integer NOT NULL,
  action_index integer NOT NULL CHECK(action_index BETWEEN 0 AND 4),
  tool text NOT NULL CHECK(tool IN ('create_reminder','add_list_item')),
  reminder_id uuid, list_item_id uuid,
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(event_id,plan_version,action_index),
  FOREIGN KEY(user_id,event_id,plan_version) REFERENCES action_plans(user_id,event_id,version),
  FOREIGN KEY(user_id,action_key,reminder_id) REFERENCES reminders(user_id,action_key,id),
  FOREIGN KEY(user_id,action_key,list_item_id) REFERENCES list_items(user_id,action_key,id),
  CHECK((tool='create_reminder' AND reminder_id IS NOT NULL AND list_item_id IS NULL)
     OR (tool='add_list_item' AND list_item_id IS NOT NULL AND reminder_id IS NULL))
);
CREATE TABLE plan_executions (
  event_id uuid PRIMARY KEY, user_id uuid NOT NULL, plan_version integer NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('executed','blocked','expired','clarify','noop','unsupported')),
  reason_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,event_id),
  FOREIGN KEY(user_id,event_id,plan_version) REFERENCES action_plans(user_id,event_id,version)
);
CREATE TABLE reply_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, event_id uuid NOT NULL UNIQUE,
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4096),
  status text NOT NULL CHECK(status IN ('pending','suppressed')),
  consent_grant_at timestamptz NOT NULL, timezone_confirmed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(user_id,event_id) REFERENCES plan_executions(user_id,event_id)
);
CREATE INDEX reply_intents_pending ON reply_intents(user_id,created_at) WHERE status='pending';

DO $policies$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['lists','list_items','reminders','action_receipts','plan_executions','reply_intents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY worker_access ON %I TO memorae_worker USING(true) WITH CHECK(true)',table_name);
    EXECUTE format('CREATE POLICY tenant_read ON %I TO memorae_tenant USING(user_id=NULLIF(current_setting(''app.user_id'',true),'''')::uuid)',table_name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',table_name);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO memorae_worker',table_name);
    EXECUTE format('GRANT SELECT ON %I TO memorae_tenant',table_name);
  END LOOP;
END $policies$;
-- Required for row locking during list append; user CRUD comes in later milestones.
GRANT UPDATE(name) ON lists TO memorae_worker;
GRANT UPDATE(status) ON reply_intents TO memorae_worker;
