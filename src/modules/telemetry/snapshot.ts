import type { PoolClient } from 'pg';
import type { Signals } from './rules.js';
export interface OperationalSnapshot {
  observedAt: string;
  signals: Signals;
  queue: { stage: string; status: string; count: number; oldestAgeSeconds: number }[];
  delivery: { state: string; deliveryStatus: string; count: number }[];
  model: { state: string; count: number }[];
  spending: { enabled: boolean; capMicros: string; reservedMicros: string; spentMicros: string };
  runtime: { component: string; heartbeatAt: string }[];
  http: Record<string, number>;
  backup: {
    enabled: boolean;
    lastVerifiedAt: string | null;
    latestState: string | null;
    offsiteVerified: false;
    [key: string]: unknown;
  };
}
// One statement snapshot: no content-bearing fields or account/provider identifiers.
export async function collectSnapshot(c: PoolClient): Promise<OperationalSnapshot> {
  const result =
    await c.query(`WITH backup AS MATERIALIZED (SELECT backup_observation() AS data), moment AS MATERIALIZED (SELECT clock_timestamp() AS at),
    recent AS (SELECT component,metric,sum(value)::bigint AS n FROM telemetry_counters,moment
      WHERE minute>=date_trunc('minute',at)-interval '4 minutes' GROUP BY component,metric),
    conflicts AS (SELECT DISTINCT a.attempt_id FROM delivery_recovery_audit a
      WHERE a.action='late_acceptance_conflict' AND NOT EXISTS(SELECT 1 FROM delivery_recovery_audit r
        WHERE r.attempt_id=a.attempt_id AND r.action='operator_accepted' AND r.created_at>a.created_at))
    SELECT jsonb_build_object(
      'observedAt',at,
      'signals',jsonb_build_object(
        'api_missing',CASE WHEN p.expect_api AND NOT EXISTS(SELECT 1 FROM telemetry_runtime WHERE component='api' AND heartbeat_at>at-interval '120 seconds') THEN 1 ELSE 0 END,
        'worker_missing',CASE WHEN p.expect_worker AND NOT EXISTS(SELECT 1 FROM telemetry_runtime WHERE component='worker' AND heartbeat_at>at-interval '120 seconds') THEN 1 ELSE 0 END,
        'api_errors',COALESCE((SELECT n FROM recent WHERE component='api' AND metric='server_error'),0),
        'api_overload',COALESCE((SELECT n FROM recent WHERE component='api' AND metric='overload'),0),
        'api_slow',COALESCE((SELECT n FROM recent WHERE component='api' AND metric='latency_slow'),0),
        'worker_errors',COALESCE((SELECT n FROM recent WHERE component='worker' AND metric='cycle_failed'),0),
        'work_stalled',(SELECT count(*) FROM work_outbox WHERE status='pending' AND available_at<=at AND created_at<=at-interval '60 seconds'),
        'work_dead',(SELECT count(*) FROM work_outbox WHERE status='dead'),
        'lease_expired',(SELECT count(*) FROM work_outbox WHERE status='leased' AND lease_until<=at),
        'model_unresolved',(SELECT count(*) FROM usage_reservations WHERE state IN ('reserved','dispatched','unknown') AND created_at<=at-interval '300 seconds'),
        'send_unknown',(SELECT count(*) FROM whatsapp_attempts WHERE state='unknown' AND recovery_state<>'abandoned' AND created_at<=at-interval '300 seconds'),
        'send_expired',(SELECT count(*) FROM whatsapp_attempts WHERE state='dispatching' AND dispatch_deadline<=at),
        'send_failed',(SELECT count(*) FROM whatsapp_attempts WHERE created_at>=at-interval '24 hours'
          AND ((state='rejected' AND recovery_state IN ('none','exhausted')) OR delivery_status='failed')),
        'send_conflict',(SELECT count(*) FROM conflicts),
        'reminders_late',(SELECT count(*) FROM reminders WHERE status='pending' AND scheduled_at IS NULL AND due_at<=at-interval '60 seconds'),
        'outbound_late',(SELECT count(*) FROM outbound_messages o WHERE o.status='pending' AND o.available_at<=at-interval '60 seconds'
          AND NOT EXISTS(SELECT 1 FROM whatsapp_attempts a WHERE a.outbound_message_id=o.id AND a.state IN ('accepted','dispatching','unknown'))),
        'receipts_unmatched',(SELECT count(*) FROM whatsapp_receipts WHERE attempt_id IS NULL AND created_at<=at-interval '300 seconds'),
        'privacy_waiting',(SELECT count(*) FROM users WHERE deletion_requested_at<=at-interval '1 hour'),
        'spend_near_cap',CASE WHEN u.enabled AND u.global_monthly_micros>0 AND
          COALESCE((SELECT reserved_micros::numeric+spent_micros FROM usage_global_periods WHERE period=date_trunc('month',at AT TIME ZONE 'UTC')::date),0)>=u.global_monthly_micros::numeric*0.9 THEN 1 ELSE 0 END
      ) || (b.data->'signals'),
      'backup',b.data-'signals',
      'queue',COALESCE((SELECT jsonb_agg(x) FROM (SELECT stage,status,count(*)::integer AS count,
        GREATEST(0,extract(epoch FROM (SELECT at FROM moment)-min(created_at)))::float8 AS "oldestAgeSeconds"
        FROM work_outbox WHERE status<>'completed' GROUP BY stage,status ORDER BY stage,status) x),'[]'),
      'delivery',COALESCE((SELECT jsonb_agg(x) FROM (SELECT state,delivery_status AS "deliveryStatus",count(*)::integer AS count FROM whatsapp_attempts GROUP BY state,delivery_status ORDER BY state,delivery_status) x),'[]'),
      'model',COALESCE((SELECT jsonb_agg(x) FROM (SELECT state,count(*)::integer AS count FROM usage_reservations GROUP BY state ORDER BY state) x),'[]'),
      'spending',jsonb_build_object('enabled',u.enabled,'capMicros',u.global_monthly_micros::text,
        'reservedMicros',COALESCE((SELECT reserved_micros::text FROM usage_global_periods WHERE period=date_trunc('month',at AT TIME ZONE 'UTC')::date),'0'),
        'spentMicros',COALESCE((SELECT spent_micros::text FROM usage_global_periods WHERE period=date_trunc('month',at AT TIME ZONE 'UTC')::date),'0')),
      'runtime',COALESCE((SELECT jsonb_agg(jsonb_build_object('component',component,'heartbeatAt',heartbeat_at) ORDER BY component) FROM telemetry_runtime),'[]'),
      'http',COALESCE((SELECT jsonb_object_agg(metric,n) FROM recent WHERE component='api'),'{}')
    ) AS data FROM moment,monitoring_policy p,usage_policy u,backup b WHERE p.singleton AND u.singleton`);
  return result.rows[0].data;
}
