-- Deployment-owned configuration. No seeded or implicitly approved Meta templates.
CREATE TABLE whatsapp_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number_id text NOT NULL CHECK(phone_number_id ~ '^[0-9]{1,30}$'),
  reply_language text NOT NULL CHECK(reply_language IN ('en','fr','es')),
  version integer NOT NULL CHECK(version>0),
  name text NOT NULL CHECK(name ~ '^[a-z0-9_]+$' AND length(name) BETWEEN 1 AND 512),
  language_code text NOT NULL CHECK(language_code ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  body_format text NOT NULL CHECK(length(body_format) BETWEEN 1 AND 1024),
  approval_status text NOT NULL DEFAULT 'pending' CHECK(approval_status IN ('pending','approved','paused','rejected')),
  approval_reference text,
  verified_at timestamptz, valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(phone_number_id,reply_language,version), UNIQUE(id,phone_number_id),
  CHECK(position('{{1}}' IN body_format)>0 AND replace(body_format,'{{1}}','') !~ '[{}]'
    AND length(body_format)-length(replace(body_format,'{{1}}',''))=5),
  CHECK(approval_status<>'approved' OR (approval_reference IS NOT NULL AND length(approval_reference)>0
    AND verified_at IS NOT NULL AND valid_until IS NOT NULL AND valid_until>verified_at))
);
CREATE FUNCTION protect_template_definition() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('whatsapp-template:'||COALESCE(NEW.phone_number_id,OLD.phone_number_id),0));
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Template history cannot be deleted; pause the version instead';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.id,NEW.phone_number_id,NEW.reply_language,NEW.version,NEW.name,NEW.language_code,NEW.body_format,NEW.created_at)
    IS DISTINCT FROM
    (OLD.id,OLD.phone_number_id,OLD.reply_language,OLD.version,OLD.name,OLD.language_code,OLD.body_format,OLD.created_at) THEN
    RAISE EXCEPTION 'Template definitions are immutable; insert a new version';
  END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION protect_template_definition() FROM PUBLIC;
CREATE TRIGGER template_definition_immutable BEFORE INSERT OR UPDATE OR DELETE ON whatsapp_templates
  FOR EACH ROW EXECUTE FUNCTION protect_template_definition();
ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_read ON whatsapp_templates FOR SELECT TO memorae_worker USING(true);
REVOKE ALL ON whatsapp_templates FROM PUBLIC;
GRANT SELECT ON whatsapp_templates TO memorae_worker;
-- Delivery can read locale preferences; it cannot edit tenant settings.
GRANT SELECT ON user_preferences TO memorae_worker;
CREATE POLICY worker_preferences_read ON user_preferences FOR SELECT TO memorae_worker USING(true);

-- Reuse receipt matching and the status reducer for all three mutually exclusive sources.
ALTER TABLE whatsapp_attempts ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE whatsapp_attempts DROP CONSTRAINT whatsapp_attempts_check;
ALTER TABLE whatsapp_attempts ADD COLUMN outbound_message_id uuid UNIQUE;
ALTER TABLE whatsapp_attempts ADD COLUMN template_id uuid;
ALTER TABLE whatsapp_attempts ADD COLUMN message_payload jsonb;
ALTER TABLE whatsapp_attempts ADD CONSTRAINT attempt_source CHECK(
  (outbound_message_id IS NULL AND event_id IS NOT NULL
    AND num_nonnulls(identity_event_id,reply_event_id)=1
    AND COALESCE(identity_event_id,reply_event_id)=event_id)
  OR (outbound_message_id IS NOT NULL AND num_nonnulls(event_id,identity_event_id,reply_event_id)=0)
);
ALTER TABLE whatsapp_attempts ADD CONSTRAINT attempt_outbound_owner
  FOREIGN KEY(user_id,outbound_message_id) REFERENCES outbound_messages(user_id,id);
ALTER TABLE whatsapp_attempts ADD CONSTRAINT attempt_template_phone
  FOREIGN KEY(template_id,phone_number_id) REFERENCES whatsapp_templates(id,phone_number_id);
ALTER TABLE whatsapp_attempts ADD CONSTRAINT attempt_payload CHECK(
  (outbound_message_id IS NULL AND template_id IS NULL AND message_payload IS NULL)
  OR (outbound_message_id IS NOT NULL AND (
    (state='suppressed' AND template_id IS NULL AND message_payload IS NULL)
    OR (state<>'suppressed' AND message_payload IS NOT NULL AND jsonb_typeof(message_payload)='object'
      AND (message_payload ? 'template')=(template_id IS NOT NULL))
  ))
);
CREATE INDEX whatsapp_attempts_unresolved ON whatsapp_attempts(user_id) WHERE state IN ('dispatching','unknown');
