ALTER TABLE users ADD CONSTRAINT users_delivery_address UNIQUE(id,business_phone_id,sender_id);
ALTER TABLE reply_intents ADD CONSTRAINT reply_intents_owner_event UNIQUE(user_id,event_id);
CREATE TABLE whatsapp_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  event_id uuid NOT NULL UNIQUE,
  identity_event_id uuid, reply_event_id uuid,
  phone_number_id text NOT NULL, recipient_id text NOT NULL,
  state text NOT NULL CHECK(state IN ('dispatching','accepted','rejected','unknown','suppressed')),
  delivery_status text NOT NULL DEFAULT 'none' CHECK(delivery_status IN ('none','sent','failed','delivered','read')),
  provider_message_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,id), UNIQUE(phone_number_id,provider_message_id),
  FOREIGN KEY(user_id,identity_event_id) REFERENCES identity_results(user_id,event_id),
  FOREIGN KEY(user_id,reply_event_id) REFERENCES reply_intents(user_id,event_id),
  FOREIGN KEY(user_id,phone_number_id,recipient_id) REFERENCES users(id,business_phone_id,sender_id),
  CHECK(num_nonnulls(identity_event_id,reply_event_id)=1 AND COALESCE(identity_event_id,reply_event_id)=event_id),
  CHECK(state<>'accepted' OR provider_message_id IS NOT NULL)
);

CREATE TABLE whatsapp_receipts (
  event_id uuid PRIMARY KEY REFERENCES ingress_events(id),
  phone_number_id text NOT NULL, provider_message_id text NOT NULL,
  recipient_id text NOT NULL, status text NOT NULL,
  occurred_at timestamptz NOT NULL,
  attempt_id uuid, user_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(user_id,attempt_id) REFERENCES whatsapp_attempts(user_id,id),
  CHECK((attempt_id IS NULL)=(user_id IS NULL))
);
CREATE INDEX whatsapp_receipts_unmatched ON whatsapp_receipts(phone_number_id,provider_message_id)
  WHERE attempt_id IS NULL;

DO $policies$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['whatsapp_attempts','whatsapp_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY worker_access ON %I TO memorae_worker USING(true) WITH CHECK(true)',table_name);
    EXECUTE format('CREATE POLICY tenant_read ON %I TO memorae_tenant USING(user_id=NULLIF(current_setting(''app.user_id'',true),'''')::uuid)',table_name);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',table_name);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO memorae_worker',table_name);
    EXECUTE format('GRANT SELECT ON %I TO memorae_tenant',table_name);
  END LOOP;
END $policies$;
GRANT UPDATE(state,delivery_status,provider_message_id,error_code,updated_at) ON whatsapp_attempts TO memorae_worker;
GRANT UPDATE(attempt_id,user_id) ON whatsapp_receipts TO memorae_worker;
