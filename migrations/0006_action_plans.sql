ALTER TABLE work_outbox DROP CONSTRAINT work_stage_topic;
ALTER TABLE work_outbox ADD CONSTRAINT work_stage_topic CHECK (
  (topic='inbound.message' AND stage IN ('onboarding','action','execution')) OR
  (topic='delivery.status' AND stage='receipt')
);

CREATE TABLE action_plans (
  event_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version=1),
  schema_version text NOT NULL CHECK(schema_version='decision-v1'),
  decision jsonb NOT NULL CHECK(jsonb_typeof(decision)='object'),
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  prompt_sha256 text NOT NULL CHECK(prompt_sha256 ~ '^[a-f0-9]{64}$'),
  input_sha256 text NOT NULL CHECK(input_sha256 ~ '^[a-f0-9]{64}$'),
  provider_response_id text,
  input_tokens integer NOT NULL CHECK(input_tokens>=0),
  output_tokens integer NOT NULL CHECK(output_tokens>=0),
  latency_ms integer NOT NULL CHECK(latency_ms>=0),
  reference_at timestamptz NOT NULL,
  validated_at timestamptz NOT NULL,
  consent_grant_at timestamptz NOT NULL,
  timezone_confirmed_at timestamptz NOT NULL,
  timezone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(user_id,event_id) REFERENCES identity_results(user_id,event_id) ON DELETE CASCADE
);
ALTER TABLE action_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_plans ON action_plans TO memorae_worker USING(true) WITH CHECK(true);
CREATE POLICY tenant_plans ON action_plans TO memorae_tenant
  USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
REVOKE ALL ON action_plans FROM PUBLIC;
-- Plans are immutable to runtime roles. Execution owns a separate receipt ledger in M1-06.
GRANT SELECT,INSERT ON action_plans TO memorae_worker;
GRANT SELECT ON action_plans TO memorae_tenant;
