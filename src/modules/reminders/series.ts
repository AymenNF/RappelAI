import { inventoryDenial } from '../quotas/service.js';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { hasOnboarded, type IdentityState } from '../identity/onboarding.js';
import { auditDelivery } from '../whatsapp/retry.js';
import { ensureReminderControl, controlHelp } from './controls.js';
import {
  recurrenceSchedule,
  DST_POLICY,
  type SeriesCommand,
  type ScheduledDate,
} from './recurrence.js';

const help =
  'Use REPEAT <reminder reference> DAILY or WEEKLY UNTIL YYYY-MM-DD. It repeats at the saved local time (and weekday for weekly), for up to one year. Review the preview, then CONFIRM REPEAT <series reference>. CANCEL SERIES <series reference> stops the whole series.';

/** The caller commits this with identity_results and the work-lease acknowledgement. */
export async function applySeriesCommand(
  client: PoolClient,
  eventId: string,
  userId: string,
  command: SeriesCommand,
): Promise<string> {
  const user = (
    await client.query(
      `SELECT u.* FROM users u JOIN ingress_events e ON e.phone_number_id=u.business_phone_id AND e.sender_id=u.sender_id
    WHERE u.id=$1 AND e.id=$2 AND e.kind='inbound.message' FOR UPDATE OF u`,
      [userId, eventId],
    )
  ).rows[0];
  if (!user) throw new Error('Recurrence event owner mismatch');
  const replay = (
    await client.query(
      'SELECT reply_text FROM reminder_series_actions WHERE event_id=$1 AND user_id=$2',
      [eventId, userId],
    )
  ).rows[0];
  if (replay) return replay.reply_text as string;
  let reply =
    'That recurrence control is no longer available. Request a new preview from a current future reminder.';
  let outcome = 'stale';
  let seriesId: string | null = null;
  if (command.action === 'invalid') {
    reply = help;
    outcome = 'invalid';
  } else if (hasOnboarded(user as IdentityState)) {
    if (command.action === 'propose') {
      const root = (
        await client.query(
          `SELECT r.*,to_char(r.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS due_iso
        FROM reminders r JOIN reminder_controls c ON c.reminder_id=r.id AND c.user_id=r.user_id JOIN users u ON u.id=r.user_id
        WHERE c.reference=$1 AND r.user_id=$2 AND r.status='pending' AND r.series_id IS NULL
          AND r.delivery_mode='immediate' AND r.scheduled_at IS NULL AND r.due_at>clock_timestamp() AND c.schedule_version=r.schedule_version
          AND c.invalidated_at IS NULL AND c.expires_at>clock_timestamp()
          AND c.consent_grant_at=u.consent_at AND c.timezone_confirmed_at=u.timezone_confirmed_at AND c.timezone=u.timezone
        FOR UPDATE OF r`,
          [command.reference, userId],
        )
      ).rows[0];
      if (root) {
        let schedule: ScheduledDate[] | undefined;
        try {
          schedule = recurrenceSchedule(
            root.due_iso,
            root.timezone,
            command.cadence,
            command.until,
          );
        } catch {
          outcome = 'invalid';
          reply = `That rule cannot repeat this reminder. Choose an end date including at least two occurrences, within 365 days of the first. A first reminder in a repeated clock hour must select the earlier offset.\n${help}`;
        }
        if (schedule) {
          const denied = await inventoryDenial(client, userId, schedule.length - 1, 0);
          if (denied) {
            outcome = 'invalid';
            reply = denied;
            schedule = undefined;
          }
        }
        if (schedule) {
          const row = (
            await client.query(
              `INSERT INTO reminder_series(user_id,source_reminder_id,source_version,source_due_at,cadence,until_date,timezone,consent_grant_at,timezone_confirmed_at,tzdb_version,schedule)
            SELECT r.user_id,r.id,r.schedule_version,r.due_at,$3,$4,r.timezone,u.consent_at,u.timezone_confirmed_at,$5,$6
            FROM reminders r JOIN users u ON u.id=r.user_id WHERE r.user_id=$1 AND r.id=$2 RETURNING id,reference`,
              [
                userId,
                root.id,
                command.cadence,
                command.until,
                process.versions.tz ?? 'unknown',
                JSON.stringify(schedule),
              ],
            )
          ).rows[0];
          seriesId = row.id;
          outcome = 'proposed';
          reply = `Preview: ${command.cadence} at the saved local time in ${root.timezone}, through ${command.until} (${schedule.length} occurrences, including the existing reminder).\n${DST_POLICY}\nNext ${Math.min(5, schedule.length)}:\n${schedule
            .slice(0, 5)
            .map((s) => s.local)
            .join(
              '\n',
            )}\nThe original reminder stays scheduled until you confirm. This preview expires in 15 minutes or when the original reminder becomes due.\nCONFIRM REPEAT ${row.reference}`;
        }
      }
    } else {
      const series = (
        await client.query(
          `SELECT s.*,s.until_date::text AS until_date,
        s.consent_grant_at=u.consent_at AND s.timezone_confirmed_at=u.timezone_confirmed_at AND s.timezone=u.timezone AS current_identity,
        s.expires_at>clock_timestamp() AS fresh
        FROM reminder_series s JOIN users u ON u.id=s.user_id WHERE s.reference=$1 AND s.user_id=$2 FOR UPDATE OF s`,
          [command.reference, userId],
        )
      ).rows[0];
      if (
        series?.current_identity &&
        command.action === 'confirm' &&
        series.status === 'proposed' &&
        series.fresh
      ) {
        const root = (
          await client.query(
            `SELECT r.* FROM reminders r JOIN reminder_series s ON s.source_reminder_id=r.id AND s.user_id=r.user_id
          WHERE r.id=$1 AND r.user_id=$2 AND r.series_id IS NULL AND s.id=$3
          AND r.status='pending' AND r.schedule_version=s.source_version AND r.due_at=s.source_due_at
          AND r.delivery_mode='immediate' AND r.due_at>clock_timestamp() AND r.scheduled_at IS NULL FOR UPDATE OF r`,
            [series.source_reminder_id, userId, series.id],
          )
        ).rows[0];
        const denied = root
          ? await inventoryDenial(
              client,
              userId,
              (series.schedule as ScheduledDate[]).length - 1,
              0,
            )
          : null;
        if (denied) {
          outcome = 'invalid';
          reply = denied;
        }
        if (root && !denied) {
          const schedule = series.schedule as ScheduledDate[];
          // One bounded INSERT compiles the finite calendar into independently controllable reminders.
          const children = schedule.slice(1).map((s) => ({
            ...s,
            key: createHash('sha256')
              .update(`recurrence-v1:${series.id}:${s.localDate}`)
              .digest('hex'),
          }));
          await client.query(
            `UPDATE reminders SET series_id=$3,series_local_date=$4,schedule_version=schedule_version+1 WHERE user_id=$1 AND id=$2`,
            [userId, root.id, series.id, schedule[0]!.localDate],
          );
          await client.query(
            `UPDATE reminder_controls SET invalidated_at=clock_timestamp() WHERE user_id=$1 AND reminder_id=$2 AND invalidated_at IS NULL`,
            [userId, root.id],
          );
          await client.query(
            `UPDATE reply_intents SET status='suppressed' WHERE user_id=$1 AND event_id=$2 AND status='pending'`,
            [userId, root.source_event_id],
          );
          await client.query(
            `INSERT INTO reminders(user_id,source_event_id,plan_version,action_key,title,due_at,timezone,delivery_mode,series_id,series_local_date)
            SELECT $1,$2,$3,x.key,$4,x.instant::timestamptz,$5,'immediate',$6,x."localDate"::date
            FROM jsonb_to_recordset($7::jsonb) AS x(key text,instant text,"localDate" text)`,
            [
              userId,
              root.source_event_id,
              root.plan_version,
              root.title,
              series.timezone,
              series.id,
              JSON.stringify(children),
            ],
          );
          await client.query(
            "UPDATE reminder_series SET status='active',updated_at=clock_timestamp() WHERE id=$1",
            [series.id],
          );
          seriesId = series.id;
          outcome = 'confirmed';
          reply = `Saved ${schedule.length} ${series.cadence} occurrences through ${String(series.until_date).slice(0, 10)} in ${series.timezone}. Done, Cancel and Snooze affect only that occurrence.\nFirst occurrence: ${controlHelp(await ensureReminderControl(client, userId, root.id))}\nStop all pending occurrences: CANCEL SERIES ${series.reference}\nLive reminder delivery is not enabled yet.`;
        }
      } else if (
        series?.current_identity &&
        command.action === 'cancel' &&
        ['proposed', 'active'].includes(series.status)
      ) {
        await client.query(
          "UPDATE reminder_series SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1",
          [series.id],
        );
        // Pending children only: terminal lifecycle and all send evidence are preserved.
        await client.query(
          `UPDATE reminders SET status='cancelled',schedule_version=schedule_version+1 WHERE user_id=$1 AND series_id=$2 AND status='pending'`,
          [userId, series.id],
        );
        await client.query(
          `UPDATE reminder_controls c SET invalidated_at=clock_timestamp() FROM reminders r WHERE r.user_id=$1 AND r.series_id=$2 AND c.user_id=r.user_id AND c.reminder_id=r.id AND c.invalidated_at IS NULL`,
          [userId, series.id],
        );
        await client.query(
          `UPDATE reminder_occurrences o SET status='suppressed',suppression_reason='reminder_changed' FROM reminders r WHERE r.user_id=$1 AND r.series_id=$2 AND o.user_id=r.user_id AND o.reminder_id=r.id AND o.status='pending'`,
          [userId, series.id],
        );
        await client.query(
          `UPDATE outbound_messages m SET status='suppressed',suppression_reason='reminder_changed' FROM reminder_occurrences o JOIN reminders r ON r.id=o.reminder_id AND r.user_id=o.user_id
          WHERE r.user_id=$1 AND r.series_id=$2 AND m.user_id=o.user_id AND m.occurrence_id=o.id AND m.status='pending'`,
          [userId, series.id],
        );
        const retries = await client.query(
          `UPDATE whatsapp_attempts a SET recovery_state='exhausted',retry_at=NULL,updated_at=clock_timestamp()
          FROM outbound_messages m JOIN reminder_occurrences o ON o.id=m.occurrence_id AND o.user_id=m.user_id JOIN reminders r ON r.id=o.reminder_id AND r.user_id=o.user_id
          WHERE r.user_id=$1 AND r.series_id=$2 AND a.outbound_message_id=m.id AND a.user_id=m.user_id AND a.recovery_state='retry_wait' RETURNING a.id,a.user_id`,
          [userId, series.id],
        );
        for (const attempt of retries.rows)
          await auditDelivery(client, attempt, 'series_cancelled');
        seriesId = series.id;
        outcome = 'cancelled';
        reply =
          series.status === 'proposed'
            ? 'Repeat proposal cancelled. Your original one-time reminder is unchanged.'
            : 'Series cancelled. Pending occurrences and queued deliveries are cancelled; messages already authorized cannot be recalled.';
      }
    }
  }
  await client.query(
    'INSERT INTO reminder_series_actions(event_id,user_id,series_id,outcome,reply_text) VALUES($1,$2,$3,$4,$5)',
    [eventId, userId, seriesId, outcome, reply],
  );
  return reply;
}
