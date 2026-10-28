-- Executable foundation only. Product tables are designed in docs/data-model.md.
CREATE TABLE ingress_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  event_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('inbound.message', 'delivery.status')),
  phone_number_id text NOT NULL,
  provider_message_id text NOT NULL,
  sender_id text,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CHECK (kind <> 'inbound.message' OR sender_id IS NOT NULL)
);
CREATE INDEX ingress_sender_pending ON ingress_events(phone_number_id, sender_id, sequence_no)
  WHERE processed_at IS NULL AND kind = 'inbound.message';

CREATE TABLE work_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES ingress_events(id) ON DELETE CASCADE,
  topic text NOT NULL CHECK (topic IN ('inbound.message', 'delivery.status')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'completed', 'dead')),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (
    (status = 'leased' AND lease_until IS NOT NULL AND lease_token IS NOT NULL)
    OR (status <> 'leased' AND lease_until IS NULL AND lease_token IS NULL)
  )
);
CREATE INDEX outbox_available ON work_outbox(available_at) WHERE status = 'pending';
CREATE INDEX outbox_expired_lease ON work_outbox(lease_until) WHERE status = 'leased';

-- Transport staging is internal-only, before a user/consent record exists.
-- Provision a dedicated ingress role before exposing this service to real users.
REVOKE ALL ON ingress_events, work_outbox FROM PUBLIC;
