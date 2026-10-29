-- Aggregates only: no message bodies, addresses, user IDs, tokens, or arbitrary labels.
CREATE TABLE telemetry_runtime (
  component text PRIMARY KEY CHECK(component IN ('api','worker')),
  heartbeat_at timestamptz NOT NULL
);
CREATE TABLE telemetry_counters (
  component text NOT NULL CHECK(component IN ('api','worker')), minute timestamptz NOT NULL,
  metric text NOT NULL, value bigint NOT NULL CHECK(value>=0), PRIMARY KEY(component,minute,metric)
);
CREATE TABLE telemetry_batches (
  id uuid PRIMARY KEY, component text NOT NULL CHECK(component IN ('api','worker')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE monitoring_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  expect_api boolean NOT NULL DEFAULT false, expect_worker boolean NOT NULL DEFAULT false
);
INSERT INTO monitoring_policy DEFAULT VALUES;
CREATE TABLE monitoring_snapshot (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), observed_at timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE TABLE monitoring_alerts (
  key text PRIMARY KEY, generation integer NOT NULL CHECK(generation>0),
  status text NOT NULL CHECK(status IN ('active','resolved')),
  severity text NOT NULL CHECK(severity IN ('warning','critical')),
  affected bigint NOT NULL CHECK(affected>=0),
  opened_at timestamptz NOT NULL, observed_at timestamptz NOT NULL,
  resolved_at timestamptz, acknowledged_at timestamptz,
  CHECK((status='resolved')=(resolved_at IS NOT NULL))
);
CREATE TABLE monitoring_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL REFERENCES monitoring_alerts(key), generation integer NOT NULL,
  transition text NOT NULL CHECK(transition IN ('opened','resolved','acknowledged')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX monitoring_events_age ON monitoring_events(created_at);
CREATE INDEX telemetry_batches_age ON telemetry_batches(created_at);
REVOKE ALL ON telemetry_runtime,telemetry_counters,telemetry_batches,monitoring_policy,monitoring_snapshot,monitoring_alerts,monitoring_events FROM PUBLIC;

-- The definer fixes its search path below. Only the corresponding authenticated login
-- may record a component, with fixed numeric counters and an idempotent batch ID.
CREATE FUNCTION record_telemetry(p_component text,p_batch uuid,p_counts jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE k text; v jsonb; allowed text[]; at_time timestamptz:=clock_timestamp(); existing text;
BEGIN
  IF p_component IS NULL OR p_component NOT IN ('api','worker') OR p_batch IS NULL OR p_counts IS NULL
    OR jsonb_typeof(p_counts)<>'object' THEN RAISE EXCEPTION 'Invalid telemetry batch'; END IF;
  IF NOT pg_has_role(session_user,CASE p_component WHEN 'api' THEN 'memorae_ingress' ELSE 'memorae_worker' END,'MEMBER') THEN
    RAISE EXCEPTION 'Telemetry component denied' USING ERRCODE='42501';
  END IF;
  allowed:=CASE p_component WHEN 'api' THEN ARRAY['requests','success','client_error','server_error','overload','latency_50','latency_200','latency_1000','latency_slow']
    ELSE ARRAY['cycles','cycle_failed','work_recovered','delivery_recovered','usage_recovered','work_cancelled'] END;
  FOR k,v IN SELECT * FROM jsonb_each(p_counts) LOOP
    IF NOT k=ANY(allowed) OR jsonb_typeof(v)<>'number' OR v::text !~ '^[0-9]+$' OR (v::text)::numeric>1000000000 THEN
      RAISE EXCEPTION 'Invalid telemetry counter';
    END IF;
  END LOOP;
  INSERT INTO telemetry_batches(id,component) VALUES(p_batch,p_component) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT component INTO existing FROM telemetry_batches WHERE id=p_batch;
    IF existing<>p_component THEN RAISE EXCEPTION 'Telemetry batch component mismatch'; END IF;
    RETURN;
  END IF;
  INSERT INTO telemetry_runtime(component,heartbeat_at) VALUES(p_component,at_time)
    ON CONFLICT(component) DO UPDATE SET heartbeat_at=EXCLUDED.heartbeat_at;
  FOR k,v IN SELECT * FROM jsonb_each(p_counts) LOOP
    INSERT INTO telemetry_counters(component,minute,metric,value)
      VALUES(p_component,date_trunc('minute',at_time),k,(v::text)::bigint)
      ON CONFLICT(component,minute,metric) DO UPDATE SET value=telemetry_counters.value+EXCLUDED.value;
  END LOOP;
END $body$;
REVOKE ALL ON FUNCTION record_telemetry(text,uuid,jsonb) FROM PUBLIC;
DO $path$ BEGIN
  EXECUTE format('ALTER FUNCTION record_telemetry(text,uuid,jsonb) SET search_path TO pg_catalog,%I,pg_temp',current_schema());
END $path$;
GRANT EXECUTE ON FUNCTION record_telemetry(text,uuid,jsonb) TO memorae_ingress,memorae_worker;
