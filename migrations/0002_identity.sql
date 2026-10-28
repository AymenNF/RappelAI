CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_phone_id text NOT NULL,
  sender_id text NOT NULL,
  consent_version text,
  consent_at timestamptz,
  consent_token uuid,
  consent_expires_at timestamptz,
  paused boolean NOT NULL DEFAULT false,
  timezone text,
  timezone_confirmed_at timestamptz,
  pending_timezone text,
  timezone_token uuid,
  timezone_expires_at timestamptz,
  last_control_at timestamptz,
  window_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_phone_id, sender_id),
  CHECK ((consent_version IS NULL) = (consent_at IS NULL)),
  CHECK ((timezone IS NULL) = (timezone_confirmed_at IS NULL))
);

CREATE TABLE identity_results (
  event_id uuid PRIMARY KEY REFERENCES ingress_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  disposition text NOT NULL CHECK (disposition IN ('handled', 'ready', 'blocked')),
  reply_text text,
  consent_grant_at timestamptz,
  timezone_confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX identity_results_user ON identity_results(user_id, created_at);

CREATE TABLE consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id uuid NOT NULL UNIQUE REFERENCES ingress_events(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('accepted', 'revoked')),
  notice_version text NOT NULL,
  notice_text text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- Internal worker-owned state only. No public user CRUD routes yet.
-- Production least-privilege roles and tenant RLS remain M1-02.
REVOKE ALL ON users, identity_results, consent_events FROM PUBLIC;
