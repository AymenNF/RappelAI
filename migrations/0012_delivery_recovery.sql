ALTER TABLE whatsapp_attempts DROP CONSTRAINT whatsapp_attempts_event_id_key;
ALTER TABLE whatsapp_attempts DROP CONSTRAINT whatsapp_attempts_outbound_message_id_key;
ALTER TABLE whatsapp_attempts ADD COLUMN attempt_no integer NOT NULL DEFAULT 1 CHECK(attempt_no BETWEEN 1 AND 3);
ALTER TABLE whatsapp_attempts ADD COLUMN previous_attempt_id uuid UNIQUE;
ALTER TABLE whatsapp_attempts ADD COLUMN dispatch_deadline timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '1 minute');
ALTER TABLE whatsapp_attempts ADD COLUMN retry_until timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '1 day');
ALTER TABLE whatsapp_attempts ADD COLUMN retry_at timestamptz;
ALTER TABLE whatsapp_attempts ADD COLUMN recovery_state text NOT NULL DEFAULT 'none'
  CHECK(recovery_state IN ('none','retry_wait','retried','exhausted','abandoned'));
ALTER TABLE whatsapp_attempts ADD COLUMN resolution text CHECK(resolution IN ('accepted','not_sent','abandoned'));
ALTER TABLE whatsapp_attempts ADD CONSTRAINT attempt_event_sequence UNIQUE(event_id,attempt_no);
ALTER TABLE whatsapp_attempts ADD CONSTRAINT attempt_outbound_sequence UNIQUE(outbound_message_id,attempt_no);
ALTER TABLE whatsapp_attempts ADD CONSTRAINT attempt_previous_owner FOREIGN KEY(user_id,previous_attempt_id) REFERENCES whatsapp_attempts(user_id,id);
ALTER TABLE whatsapp_attempts ADD CONSTRAINT attempt_previous_required CHECK((attempt_no=1)=(previous_attempt_id IS NULL));
ALTER TABLE whatsapp_attempts ADD CONSTRAINT attempt_retry_state CHECK(
  (recovery_state='retry_wait')=(retry_at IS NOT NULL)
  AND (recovery_state NOT IN ('retry_wait','retried') OR (state='rejected' AND provider_message_id IS NULL))
);
UPDATE whatsapp_attempts SET dispatch_deadline=created_at+interval '1 minute',retry_until=created_at+interval '1 day';
CREATE INDEX whatsapp_attempts_recovery_due ON whatsapp_attempts(dispatch_deadline) WHERE state='dispatching';
CREATE INDEX whatsapp_attempts_retry_due ON whatsapp_attempts(retry_at) WHERE recovery_state='retry_wait';
GRANT UPDATE(recovery_state,retry_at,resolution) ON whatsapp_attempts TO memorae_worker;

-- Bound retry chains even if competing callers bypass the application-level user lock.
CREATE FUNCTION guard_delivery_retry() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE previous whatsapp_attempts%ROWTYPE;
BEGIN
  IF NEW.previous_attempt_id IS NOT NULL THEN
    SELECT * INTO previous FROM whatsapp_attempts WHERE id=NEW.previous_attempt_id FOR UPDATE;
    IF NOT FOUND OR previous.user_id<>NEW.user_id OR previous.attempt_no+1<>NEW.attempt_no
      OR previous.event_id IS DISTINCT FROM NEW.event_id
      OR previous.outbound_message_id IS DISTINCT FROM NEW.outbound_message_id
      OR previous.identity_event_id IS DISTINCT FROM NEW.identity_event_id
      OR previous.reply_event_id IS DISTINCT FROM NEW.reply_event_id
      OR previous.state<>'rejected' OR previous.provider_message_id IS NOT NULL
      OR previous.recovery_state<>'retry_wait' OR previous.retry_at>clock_timestamp()
      OR previous.retry_until<=clock_timestamp() OR NEW.retry_until<>previous.retry_until THEN
      RAISE EXCEPTION 'Invalid or ineligible delivery retry' USING ERRCODE='23514';
    END IF;
    UPDATE whatsapp_attempts SET recovery_state='retried',retry_at=NULL,updated_at=clock_timestamp() WHERE id=previous.id;
  END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION guard_delivery_retry() FROM PUBLIC;
CREATE TRIGGER delivery_retry_guard BEFORE INSERT ON whatsapp_attempts FOR EACH ROW EXECUTE FUNCTION guard_delivery_retry();

CREATE TABLE delivery_recovery_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, attempt_id uuid NOT NULL,
  action text NOT NULL, actor text NOT NULL DEFAULT current_user,
  details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(user_id,attempt_id) REFERENCES whatsapp_attempts(user_id,id)
);
CREATE INDEX delivery_recovery_audit_attempt_action ON delivery_recovery_audit(attempt_id,action,created_at);
ALTER TABLE delivery_recovery_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_recovery_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_access ON delivery_recovery_audit TO memorae_worker USING(true) WITH CHECK(true);
CREATE POLICY tenant_read ON delivery_recovery_audit FOR SELECT TO memorae_tenant
  USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
REVOKE ALL ON delivery_recovery_audit FROM PUBLIC;
GRANT SELECT,INSERT ON delivery_recovery_audit TO memorae_worker;
GRANT SELECT ON delivery_recovery_audit TO memorae_tenant;
CREATE FUNCTION guard_delivery_audit() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  NEW.actor=current_user;
  IF NEW.action LIKE 'operator\_%' ESCAPE '\' AND NOT pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid=TG_RELID),'MEMBER') THEN
    RAISE EXCEPTION 'Operator audit requires the migration administrator' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION guard_delivery_audit() FROM PUBLIC;
CREATE TRIGGER delivery_audit_guard BEFORE INSERT ON delivery_recovery_audit FOR EACH ROW EXECUTE FUNCTION guard_delivery_audit();

-- Workers may record transport results/recoveries but cannot manufacture operator resolutions.
CREATE FUNCTION guard_delivery_resolution() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF ((TG_OP='INSERT' AND (NEW.resolution IS NOT NULL OR NEW.recovery_state='abandoned'))
      OR (TG_OP='UPDATE' AND (NEW.resolution IS DISTINCT FROM OLD.resolution
        OR (NEW.recovery_state='abandoned' AND OLD.recovery_state<>'abandoned'))))
    AND NOT pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid=TG_RELID),'MEMBER') THEN
    RAISE EXCEPTION 'Delivery resolution requires the migration administrator' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION guard_delivery_resolution() FROM PUBLIC;
CREATE TRIGGER delivery_resolution_guard BEFORE INSERT OR UPDATE ON whatsapp_attempts FOR EACH ROW EXECUTE FUNCTION guard_delivery_resolution();
