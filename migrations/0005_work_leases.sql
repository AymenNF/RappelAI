ALTER TABLE work_outbox ADD COLUMN stage text NOT NULL DEFAULT 'onboarding';
ALTER TABLE work_outbox ADD COLUMN lease_owner text;
ALTER TABLE work_outbox ADD COLUMN max_attempts integer NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 20);

UPDATE work_outbox SET stage='receipt' WHERE topic='delivery.status';
UPDATE work_outbox q SET stage='action' FROM identity_results r
  WHERE r.event_id=q.event_id AND r.disposition='ready';
-- No previous release executes external work. Release pre-upgrade claims for replay.
UPDATE work_outbox SET status='pending',lease_token=NULL,lease_until=NULL,last_error_code='migration_recovery'
  WHERE status='leased';
ALTER TABLE work_outbox ADD CONSTRAINT work_stage_topic CHECK (
  (topic='inbound.message' AND stage IN ('onboarding','action')) OR
  (topic='delivery.status' AND stage='receipt')
);
ALTER TABLE work_outbox ADD CONSTRAINT lease_has_owner CHECK ((status='leased')=(lease_owner IS NOT NULL));
CREATE INDEX work_claimable_stage ON work_outbox(stage,available_at) WHERE status='pending';
CREATE INDEX ingress_work_stream ON ingress_events
  (phone_number_id,kind,(COALESCE(sender_id,provider_message_id)),sequence_no);

CREATE TABLE work_recovery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id uuid NOT NULL REFERENCES work_outbox(id) ON DELETE CASCADE,
  action text NOT NULL CHECK(action IN ('expired_retry','attempts_exhausted','operator_retry')),
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON work_recovery_events FROM PUBLIC;
GRANT SELECT,INSERT ON work_recovery_events TO memorae_worker;
