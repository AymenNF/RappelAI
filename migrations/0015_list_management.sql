ALTER TABLE lists ADD COLUMN reference text NOT NULL DEFAULT substr(replace(gen_random_uuid()::text,'-',''),1,16)
  UNIQUE CHECK(reference ~ '^[a-f0-9]{16}$');
ALTER TABLE lists ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
CREATE INDEX lists_owner_reference ON lists(user_id,reference);
ALTER TABLE list_items ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE list_items ADD CONSTRAINT list_item_owner_id UNIQUE(user_id,id);
ALTER TABLE list_items ADD CONSTRAINT list_item_owner_list_id UNIQUE(user_id,list_id,id);
GRANT UPDATE(text,completed) ON list_items TO memorae_worker;
GRANT UPDATE(revision) ON lists TO memorae_worker;

CREATE FUNCTION version_list_item() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  NEW.revision=OLD.revision+CASE WHEN NEW.text IS DISTINCT FROM OLD.text OR NEW.completed IS DISTINCT FROM OLD.completed THEN 1 ELSE 0 END;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION version_list_item() FROM PUBLIC;
CREATE TRIGGER list_item_version BEFORE UPDATE ON list_items FOR EACH ROW EXECUTE FUNCTION version_list_item();
CREATE FUNCTION version_list_membership() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF TG_OP='INSERT' OR NEW.text IS DISTINCT FROM OLD.text OR NEW.completed IS DISTINCT FROM OLD.completed THEN
    UPDATE lists SET revision=revision+1 WHERE user_id=NEW.user_id AND id=NEW.list_id;
  END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION version_list_membership() FROM PUBLIC;
CREATE TRIGGER list_membership_version AFTER INSERT OR UPDATE OF text,completed ON list_items
  FOR EACH ROW EXECUTE FUNCTION version_list_membership();

CREATE TABLE list_choices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id),
  reference text NOT NULL UNIQUE DEFAULT substr(replace(gen_random_uuid()::text,'-',''),1,16) CHECK(reference ~ '^[a-f0-9]{16}$'),
  kind text NOT NULL CHECK(kind IN ('lists','items')),request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
  consent_grant_at timestamptz NOT NULL,timezone_confirmed_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','consumed','superseded','invalidated')),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(user_id,id)
);
CREATE INDEX list_choices_pending ON list_choices(user_id) WHERE status='pending';
CREATE TABLE list_choice_options (
  user_id uuid NOT NULL,choice_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 5),
  list_id uuid NOT NULL,list_revision integer NOT NULL CHECK(list_revision>0),
  item_id uuid,item_revision integer CHECK(item_revision>0),
  PRIMARY KEY(choice_id,ordinal),
  FOREIGN KEY(user_id,choice_id) REFERENCES list_choices(user_id,id),
  FOREIGN KEY(user_id,list_id) REFERENCES lists(user_id,id),
  FOREIGN KEY(user_id,list_id,item_id) REFERENCES list_items(user_id,list_id,id),
  CHECK((item_id IS NULL)=(item_revision IS NULL))
);
CREATE TABLE list_actions (
  event_id uuid PRIMARY KEY REFERENCES ingress_events(id),user_id uuid NOT NULL REFERENCES users(id),
  choice_id uuid,list_id uuid,item_id uuid,
  outcome text NOT NULL CHECK(outcome IN ('read','clarify','edited','completed','noop','stale','not_found','invalid','blocked')),
  reply_text text NOT NULL,result jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(user_id,choice_id) REFERENCES list_choices(user_id,id),
  FOREIGN KEY(user_id,list_id) REFERENCES lists(user_id,id),
  FOREIGN KEY(user_id,list_id,item_id) REFERENCES list_items(user_id,list_id,id),
  CHECK(item_id IS NULL OR list_id IS NOT NULL)
);
CREATE TRIGGER list_action_owner BEFORE INSERT ON list_actions FOR EACH ROW EXECUTE FUNCTION check_identity_event_owner();
DO $policies$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['list_choices','list_choice_options','list_actions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY worker_access ON %I TO memorae_worker USING(true) WITH CHECK(true)',table_name);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO memorae_tenant USING(user_id=NULLIF(current_setting(''app.user_id'',true),'''')::uuid)',table_name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',table_name);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO memorae_worker',table_name);
    EXECUTE format('GRANT SELECT ON %I TO memorae_tenant',table_name);
  END LOOP;
END $policies$;
GRANT UPDATE(status) ON list_choices TO memorae_worker;
