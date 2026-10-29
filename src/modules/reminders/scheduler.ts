import type { Pool } from 'pg';
import { hasOnboarded, type IdentityState } from '../identity/onboarding.js';

export interface SweepResult {
  examined: number;
  materialized: number;
  suppressed: number;
}

/** One-time reminders only. Materialization is local database work, never a provider send. */
export class ReminderScheduler {
  constructor(private readonly pool: Pool) {}

  async sweep(limit = 100, signal?: AbortSignal): Promise<SweepResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Sweep limit must be an integer from 1 to 500');
    const result: SweepResult = { examined: 0, materialized: 0, suppressed: 0 };
    if (signal?.aborted) return result;
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      // Keep microseconds in PostgreSQL. One fixed database cutoff per sweep, never the host clock.
      const cutoff = (await client.query('SELECT clock_timestamp()::text AS cutoff')).rows[0]
        .cutoff;
      // User before reminder before outbound: same user lock as onboarding/execution.
      // Skip a busy user rather than hold up other users or invert the lock order.
      const users = await client.query(
        `SELECT u.*,(SELECT min(r.due_at) FROM reminders r WHERE r.user_id=u.id
          AND r.status='pending' AND r.scheduled_at IS NULL AND r.due_at<=$1::timestamptz) AS earliest_due
        FROM users u WHERE EXISTS(SELECT 1 FROM reminders r WHERE r.user_id=u.id
          AND r.status='pending' AND r.scheduled_at IS NULL AND r.due_at<=$1::timestamptz)
        ORDER BY earliest_due,u.id LIMIT $2 FOR UPDATE OF u SKIP LOCKED`,
        [cutoff, limit],
      );
      for (const user of users.rows) {
        if (result.examined >= limit) break;
        const due = await client.query(
          `SELECT r.id,p.consent_grant_at=u.consent_at
            AND p.timezone_confirmed_at=u.timezone_confirmed_at AND p.timezone=u.timezone AS matches_snapshot
          FROM reminders r JOIN users u ON u.id=r.user_id
          JOIN action_plans p ON p.user_id=r.user_id AND p.event_id=r.source_event_id AND p.version=r.plan_version
          WHERE r.user_id=$1 AND r.status='pending' AND r.scheduled_at IS NULL AND r.due_at<=$2::timestamptz
          ORDER BY r.due_at,r.id LIMIT $3 FOR UPDATE OF r SKIP LOCKED`,
          [user.id, cutoff, limit - result.examined],
        );
        for (const reminder of due.rows) {
          if (signal?.aborted) throw new Error('Sweep cancelled');
          const suppressed = !hasOnboarded(user as IdentityState) || !reminder.matches_snapshot;
          const inserted = await client.query(
            `INSERT INTO reminder_occurrences(user_id,reminder_id,schedule_version,original_due_at,promised_due_at,status,suppression_reason)
            SELECT user_id,id,schedule_version,due_at,due_at,$2,$3 FROM reminders WHERE id=$1
            ON CONFLICT(reminder_id,schedule_version,original_due_at) DO NOTHING RETURNING id`,
            [
              reminder.id,
              suppressed ? 'suppressed' : 'pending',
              suppressed ? 'identity_changed' : null,
            ],
          );
          if (suppressed) {
            // Replaying a previously materialized occurrence may only narrow its eligibility.
            await client.query(
              `WITH stale AS (
                UPDATE reminder_occurrences o SET status='suppressed',suppression_reason='identity_changed'
                FROM reminders r WHERE r.id=$1 AND o.reminder_id=r.id AND o.user_id=r.user_id
                  AND o.schedule_version=r.schedule_version AND o.original_due_at=r.due_at
                RETURNING o.id
              ) UPDATE outbound_messages m SET status='suppressed',suppression_reason='identity_changed'
                FROM stale WHERE m.occurrence_id=stale.id AND m.status='pending'`,
              [reminder.id],
            );
          }
          // Read the durable occurrence state on replay; never revive a suppressed intent.
          await client.query(
            `INSERT INTO outbound_messages(user_id,occurrence_id,body,available_at,consent_grant_at,timezone_confirmed_at,timezone,status,suppression_reason)
            SELECT o.user_id,o.id,'Reminder: '||r.title,o.promised_due_at,p.consent_grant_at,p.timezone_confirmed_at,
              p.timezone,o.status,o.suppression_reason
            FROM reminders r JOIN reminder_occurrences o ON o.reminder_id=r.id AND o.user_id=r.user_id
              AND o.schedule_version=r.schedule_version AND o.original_due_at=r.due_at
            JOIN action_plans p ON p.user_id=r.user_id AND p.event_id=r.source_event_id AND p.version=r.plan_version
            WHERE r.id=$1 ON CONFLICT(occurrence_id) DO NOTHING`,
            [reminder.id],
          );
          await client.query('UPDATE reminders SET scheduled_at=clock_timestamp() WHERE id=$1', [
            reminder.id,
          ]);
          result.examined++;
          if (inserted.rowCount) {
            result.materialized++;
            if (suppressed) result.suppressed++;
          }
        }
      }
      if (signal?.aborted) throw new Error('Sweep cancelled');
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
}
