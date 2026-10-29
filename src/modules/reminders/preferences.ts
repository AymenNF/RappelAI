import { Temporal } from '@js-temporal/polyfill';
import type { PoolClient } from 'pg';
import { hasOnboarded, type IdentityState } from '../identity/onboarding.js';
import { controlHelp, ensureReminderControl } from './controls.js';
import { deliveryTime, timeLabel, TIME_POLICY, type PreferenceCommand } from './delivery-time.js';

const localTime = (instant: string, zone: string) =>
  Temporal.Instant.from(instant).toZonedDateTimeISO(zone).toString();

const promise =
  'Exact-time reminders bypass quiet hours and digest preferences. Existing promises never move automatically. Live delivery is not enabled yet.';
const help =
  'PREFERENCES; DIGEST AT HH:MM or DIGEST OFF; QUIET HH:MM-HH:MM or QUIET OFF. To change one future reminder: DELIVER <reminder reference> EXACT, DIGEST or QUIET, then CONFIRM DELIVERY <preview reference>.';

/** Caller commits with the onboarding lease. Lock order: user, preference, choice, reminder. */
export async function applyPreferenceCommand(
  client: PoolClient,
  eventId: string,
  userId: string,
  command: PreferenceCommand,
): Promise<string> {
  const user = (
    await client.query(
      `SELECT u.* FROM users u JOIN ingress_events e ON e.phone_number_id=u.business_phone_id AND e.sender_id=u.sender_id
    WHERE u.id=$1 AND e.id=$2 AND e.kind='inbound.message' FOR UPDATE OF u`,
      [userId, eventId],
    )
  ).rows[0];
  if (!user) throw new Error('Delivery preference event owner mismatch');
  const replay = (
    await client.query(
      'SELECT reply_text FROM delivery_preference_actions WHERE user_id=$1 AND event_id=$2',
      [userId, eventId],
    )
  ).rows[0];
  if (replay) return replay.reply_text as string;
  let outcome = 'stale',
    choiceId: string | null = null;
  let reply =
    'That delivery preview/control is unavailable or stale. Request a new preview for a future reminder. Nothing changed.';
  if (command.action === 'invalid') {
    outcome = 'invalid';
    reply = help;
  } else if (hasOnboarded(user as IdentityState)) {
    // A settings/consent change resets preferences. Old promises retain their identity gates.
    await client.query(
      `INSERT INTO delivery_preferences(user_id,consent_grant_at,timezone_confirmed_at,timezone)
      VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET
      revision=delivery_preferences.revision+1,digest_minute=NULL,quiet_start=NULL,quiet_end=NULL,
      consent_grant_at=EXCLUDED.consent_grant_at,timezone_confirmed_at=EXCLUDED.timezone_confirmed_at,timezone=EXCLUDED.timezone,active=true
      WHERE NOT delivery_preferences.active OR delivery_preferences.consent_grant_at IS DISTINCT FROM EXCLUDED.consent_grant_at
      OR delivery_preferences.timezone_confirmed_at IS DISTINCT FROM EXCLUDED.timezone_confirmed_at OR delivery_preferences.timezone<>EXCLUDED.timezone`,
      [userId, user.consent_at, user.timezone_confirmed_at, user.timezone],
    );
    let prefs = (
      await client.query('SELECT * FROM delivery_preferences WHERE user_id=$1 FOR UPDATE', [userId])
    ).rows[0];
    if (command.action === 'show' || command.action === 'digest' || command.action === 'quiet') {
      if (command.action !== 'show') {
        prefs = (
          await client.query(
            `UPDATE delivery_preferences SET revision=revision+1,
          digest_minute=$2,quiet_start=$3,quiet_end=$4 WHERE user_id=$1 RETURNING *`,
            [
              userId,
              command.action === 'digest' ? command.minute : prefs.digest_minute,
              command.action === 'quiet' ? command.start : prefs.quiet_start,
              command.action === 'quiet' ? command.end : prefs.quiet_end,
            ],
          )
        ).rows[0];
        await client.query(
          "UPDATE delivery_choices SET status='invalidated' WHERE user_id=$1 AND status='pending'",
          [userId],
        );
      }
      outcome = command.action === 'show' ? 'shown' : 'updated';
      reply = `Preferences in ${user.timezone}: daily digest ${prefs.digest_minute === null ? 'off' : timeLabel(prefs.digest_minute)}; quiet hours ${prefs.quiet_start === null ? 'off' : `${timeLabel(prefs.quiet_start)}-${timeLabel(prefs.quiet_end)}`}.\n${promise}\nDigest entries are individual messages at the daily slot, not a combined summary. Only explicitly confirmed reminders use these preferences. Turning a preference off does not cancel previously confirmed delivery times.\n${help}`;
    } else if (command.action === 'propose') {
      const r = (
        await client.query(
          `SELECT r.*,to_char(r.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS due_iso
        FROM reminders r JOIN reminder_controls c ON c.user_id=r.user_id AND c.reminder_id=r.id
        WHERE r.user_id=$1 AND c.reference=$2 AND c.schedule_version=r.schedule_version AND c.invalidated_at IS NULL
        AND c.expires_at>clock_timestamp() AND c.consent_grant_at=$3 AND c.timezone_confirmed_at=$4 AND c.timezone=$5
        AND r.status='pending' AND r.scheduled_at IS NULL AND r.due_at>clock_timestamp() FOR UPDATE OF r`,
          [userId, command.reference, user.consent_at, user.timezone_confirmed_at, user.timezone],
        )
      ).rows[0];
      if (r) {
        let proposed: string | undefined;
        try {
          proposed = deliveryTime(r.due_iso, user.timezone, command.mode, prefs);
        } catch {
          outcome = 'invalid';
          reply = `Set a valid ${command.mode} preference first. Nothing changed.\n${help}`;
        }
        if (proposed) {
          await client.query(
            "UPDATE delivery_choices SET status='invalidated' WHERE user_id=$1 AND status='pending'",
            [userId],
          );
          const c = (
            await client.query(
              `INSERT INTO delivery_choices(user_id,reminder_id,schedule_version,preference_revision,mode,original_due_at,promised_due_at,consent_grant_at,timezone_confirmed_at,timezone,tzdb_version,preference_snapshot)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,reference`,
              [
                userId,
                r.id,
                r.schedule_version,
                prefs.revision,
                command.mode,
                r.due_iso,
                proposed,
                user.consent_at,
                user.timezone_confirmed_at,
                user.timezone,
                process.versions.tz ?? 'unknown',
                {
                  digest_minute: prefs.digest_minute,
                  quiet_start: prefs.quiet_start,
                  quiet_end: prefs.quiet_end,
                },
              ],
            )
          ).rows[0];
          choiceId = c.id;
          outcome = 'proposed';
          reply = `Delivery preview for “${r.title}” (${command.mode}):\nOriginal due: ${localTime(r.due_iso, user.timezone)}\nCurrent delivery: ${localTime(r.promised_due_at?.toISOString() ?? r.due_iso, user.timezone)}\nProposed delivery: ${localTime(proposed, user.timezone)}.\n${TIME_POLICY}\n${command.mode === 'digest' ? 'This entry uses the daily digest slot and quiet hours; entries are sent individually.\n' : ''}Nothing changed. This affects only this occurrence. Confirm within 15 minutes and before the original due time:\nCONFIRM DELIVERY ${c.reference}\n${promise}`;
        }
      }
    } else if (command.action === 'confirm') {
      const c = (
        await client.query(
          `SELECT * FROM delivery_choices WHERE user_id=$1 AND reference=$2 AND status='pending'
        AND preference_revision=$3 AND consent_grant_at=$4 AND timezone_confirmed_at=$5 AND timezone=$6 FOR UPDATE`,
          [
            userId,
            command.reference,
            prefs.revision,
            user.consent_at,
            user.timezone_confirmed_at,
            user.timezone,
          ],
        )
      ).rows[0];
      if (c) {
        // Database predicates recheck expiry and original due after acquiring the reminder lock.
        await client.query('SELECT id FROM reminders WHERE user_id=$1 AND id=$2 FOR UPDATE', [
          userId,
          c.reminder_id,
        ]);
        const r = (
          await client.query(
            `UPDATE reminders r SET schedule_version=r.schedule_version+1,
          delivery_mode=CASE WHEN c.mode='exact' THEN 'immediate' ELSE c.mode END,
          promised_due_at=CASE WHEN c.mode='exact' THEN NULL ELSE c.promised_due_at END,
          delivery_choice_id=CASE WHEN c.mode='exact' THEN NULL ELSE c.id END
          FROM delivery_choices c WHERE c.id=$1 AND c.user_id=r.user_id AND c.reminder_id=r.id
          AND c.expires_at>clock_timestamp() AND c.original_due_at=r.due_at AND r.due_at>clock_timestamp()
          AND r.status='pending' AND r.scheduled_at IS NULL AND r.schedule_version=c.schedule_version
          RETURNING r.id,r.source_event_id,to_char(COALESCE(r.promised_due_at,r.due_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS delivery_at`,
            [c.id],
          )
        ).rows[0];
        choiceId = c.id;
        await client.query('UPDATE delivery_choices SET status=$2 WHERE id=$1', [
          c.id,
          r ? 'consumed' : 'invalidated',
        ]);
        if (r) {
          await client.query(
            'UPDATE reminder_controls SET invalidated_at=clock_timestamp() WHERE user_id=$1 AND reminder_id=$2 AND invalidated_at IS NULL',
            [userId, r.id],
          );
          await client.query(
            "UPDATE reply_intents SET status='suppressed' WHERE user_id=$1 AND event_id=$2 AND status='pending'",
            [userId, r.source_event_id],
          );
          outcome = 'confirmed';
          reply = `Confirmed ${c.mode} delivery for ${localTime(r.delivery_at, user.timezone)}. Original due time is retained. Future preference edits will not move this promise. Snooze creates a new exact-time reminder.\n${controlHelp(await ensureReminderControl(client, userId, r.id))}\n${promise}`;
        }
      }
    }
  }
  await client.query(
    'INSERT INTO delivery_preference_actions(event_id,user_id,choice_id,outcome,reply_text) VALUES($1,$2,$3,$4,$5)',
    [eventId, userId, choiceId, outcome, reply],
  );
  return reply;
}
