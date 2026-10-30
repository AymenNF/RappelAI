import type { Pool } from 'pg';
import { z } from 'zod';
export function utcReviewDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Use a UTC calendar day YYYY-MM-DD');
  const start = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== value)
    throw new Error('Invalid UTC date');
  return {
    day: value,
    start: start.toISOString(),
    end: new Date(start.getTime() + 86400000).toISOString(),
  };
}
export class BetaDailyReview {
  constructor(private pool: Pool) {}
  async run(day: string, dailyModelReviewMicros: string) {
    const window = utcReviewDay(day);
    z.string()
      .regex(/^(0|[1-9]\d{0,29})$/)
      .parse(dailyModelReviewMicros);
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const access = (
        await c.query(
          "SELECT pg_has_role(current_user,'memorae_monitor','MEMBER') OR pg_has_role(current_user,relowner,'MEMBER') AS allowed FROM pg_class WHERE oid='usage_policy'::regclass",
        )
      ).rows[0];
      if (!access?.allowed)
        throw new Error('Daily review requires monitor or administrator access');
      await c.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended(current_schema()||':privacy',0))",
      );
      await c.query('SET LOCAL jit=off');
      const now = (await c.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      if (Date.parse(window.start) > now.getTime()) throw new Error('Cannot review a future day');
      const cutoff = new Date(Math.min(Date.parse(window.end), now.getTime())).toISOString();
      const cost = (
        await c.query(
          `SELECT COALESCE(d.settled_micros,0)::text AS "settledMicros",COALESCE(d.settled_calls,0)::text AS "settledCalls",
        t.started_at AS "trackingStartedAt",t.started_at<=$2::timestamptz AS "fullDayCoverage"
        FROM beta_review_tracking t LEFT JOIN usage_daily_costs d ON d.day=$1::date WHERE t.singleton`,
          [day, window.start],
        )
      ).rows[0];
      const unresolved = (
        await c.query(`SELECT count(*)::int AS count,COALESCE(sum(reserved_micros),0)::text AS "heldMicros"
        FROM usage_reservations WHERE state IN ('reserved','dispatched','unknown')`)
      ).rows[0];
      const budget = (
        await c.query(
          `SELECT p.enabled,p.global_monthly_micros::text AS "capMicros",COALESCE(g.spent_micros,0)::text AS "spentMicros",COALESCE(g.reserved_micros,0)::text AS "reservedMicros"
        FROM usage_policy p LEFT JOIN usage_global_periods g ON g.period=date_trunc('month',$1::timestamptz AT TIME ZONE 'UTC')::date WHERE p.singleton`,
          [now.toISOString()],
        )
      ).rows[0];
      const delivery = (
        await c.query(
          `WITH cohort AS (
        SELECT id,available_at,status FROM outbound_messages WHERE available_at>=$1 AND available_at<$2
      ), observed AS (
        SELECT o.*, EXISTS(SELECT 1 FROM whatsapp_attempts a WHERE a.outbound_message_id=o.id AND a.state='accepted') AS accepted,
          EXISTS(SELECT 1 FROM whatsapp_attempts a WHERE a.outbound_message_id=o.id AND a.state IN ('dispatching','unknown') AND a.recovery_state<>'abandoned') AS uncertain,
          (SELECT min(r.occurred_at) FROM whatsapp_attempts a JOIN whatsapp_receipts r ON r.attempt_id=a.id
            WHERE a.outbound_message_id=o.id AND r.status IN ('delivered','read') AND r.occurred_at<=$3) AS delivered_at
        FROM cohort o
      ) SELECT count(*)::int AS materialized,
        count(*) FILTER(WHERE status='suppressed')::int AS suppressed,
        count(*) FILTER(WHERE status<>'suppressed')::int AS eligible,
        count(*) FILTER(WHERE status<>'suppressed' AND accepted)::int AS accepted,
        count(*) FILTER(WHERE status<>'suppressed' AND delivered_at IS NOT NULL)::int AS confirmed,
        count(*) FILTER(WHERE status<>'suppressed' AND delivered_at>=available_at AND delivered_at<=available_at+interval '60 seconds')::int AS "onTime",
        count(*) FILTER(WHERE status<>'suppressed' AND uncertain)::int AS uncertain,
        count(*) FILTER(WHERE status<>'suppressed' AND delivered_at<available_at)::int AS "timingAnomalies"
        FROM observed`,
          [window.start, cutoff, now.toISOString()],
        )
      ).rows[0];
      const unmaterialized = (
        await c.query(
          `SELECT count(*)::int AS n FROM reminders WHERE status='pending' AND scheduled_at IS NULL
        AND COALESCE(promised_due_at,due_at)>=$1 AND COALESCE(promised_due_at,due_at)<$2`,
          [window.start, cutoff],
        )
      ).rows[0].n as number;
      const feedback = (
        await c.query(
          `SELECT category,status,count(*)::int AS count FROM beta_feedback WHERE created_at>=$1 AND created_at<$2 GROUP BY category,status ORDER BY category,status`,
          [window.start, cutoff],
        )
      ).rows;
      const openFeedback = (
        await c.query("SELECT count(*)::int AS n FROM beta_feedback WHERE status<>'resolved'")
      ).rows[0].n as number;
      await c.query('COMMIT');
      const denominator = delivery.eligible + unmaterialized;
      const attention: string[] = [];
      if (now.getTime() < Date.parse(window.end)) attention.push('provisional_day');
      if (!cost?.fullDayCoverage) attention.push('cost_history_incomplete');
      if (BigInt(cost?.settledMicros ?? '0') > BigInt(dailyModelReviewMicros))
        attention.push('model_cost_review_threshold');
      if (unresolved.count) attention.push('unresolved_model_usage');
      if (delivery.uncertain) attention.push('uncertain_sends');
      if (denominator === 0) attention.push('no_delivery_sample');
      else if (delivery.onTime < denominator) attention.push('delivery_evidence_gap');
      if (delivery.timingAnomalies) attention.push('provider_clock_anomaly');
      if (openFeedback) attention.push('feedback_needs_review');
      return {
        version: 'beta-daily-review-v1',
        window: { ...window, timezone: 'UTC', observedThrough: cutoff },
        observedAt: now.toISOString(),
        completeDay: now.getTime() >= Date.parse(window.end),
        modelCosts: {
          ...cost,
          currency: 'USD',
          unit: 'micros',
          basis: 'settlement day, not request day',
          reviewThresholdMicros: dailyModelReviewMicros,
          unresolvedCurrent: unresolved,
        },
        currentMonthlyBudget: budget,
        otherCosts: { whatsapp: 'not_tracked', hosting: 'not_tracked' },
        delivery: {
          ...delivery,
          unmaterialized,
          onTimeEvidence: { numerator: delivery.onTime, denominator },
          basis: 'retained current promises; one intent across all retries; observed receipt time',
        },
        feedback: { receivedInWindow: feedback, openCurrent: openFeedback },
        attention,
        launchEnabled: false,
        limits: [
          'Review does not change spending or launch settings.',
          'Delivery/feedback history can change after late receipts, edits or account deletion; this is an observation, not a final SLO.',
          'Provider acceptance is not delivery. Missing receipts are not proof of failure.',
          'Model totals exclude WhatsApp, hosting and other provider invoices.',
        ],
      };
    } catch (e) {
      try {
        await c.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw e;
    } finally {
      c.release(discard);
    }
  }
}
