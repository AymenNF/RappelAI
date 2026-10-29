import type { PoolClient } from 'pg';
import { hasOnboarded, type IdentityState } from '../identity/onboarding.js';
import { auditDelivery } from '../whatsapp/retry.js';

export type ReminderCommand =
  | { action: 'complete' | 'cancel' | 'snooze'; reference: string; minutes: number }
  | { action: 'invalid' };

/** Reserved commands are deterministic; neither titles nor button display text authorize changes. */
export function reminderCommand(payload: Record<string, unknown>): ReminderCommand | null {
  if (payload.type === 'interactive' || payload.type === 'button') {
    const interactive = payload.interactive as
      { type?: unknown; button_reply?: { id?: unknown } } | undefined;
    const id =
      payload.type === 'interactive' && interactive?.type === 'button_reply'
        ? interactive.button_reply?.id
        : payload.type === 'button'
          ? (payload.button as { payload?: unknown } | undefined)?.payload
          : null;
    const match =
      typeof id === 'string' ? /^reminder:([a-f0-9]{16}):(complete|cancel|snooze)$/.exec(id) : null;
    return match
      ? { action: match[2] as 'complete' | 'cancel' | 'snooze', reference: match[1]!, minutes: 10 }
      : { action: 'invalid' };
  }
  const text =
    payload.type === 'text' ? (payload.text as { body?: unknown } | undefined)?.body : null;
  if (typeof text !== 'string' || !/^(DONE|COMPLETE|CANCEL|SNOOZE)\b/i.test(text.trim()))
    return null;
  const match = /^(DONE|COMPLETE|CANCEL|SNOOZE)\s+([a-f0-9]{16})(?:\s+(\d{1,4})m)?$/i.exec(
    text.trim(),
  );
  if (!match) return { action: 'invalid' };
  const verb = match[1]!.toUpperCase();
  const minutes = Number(match[3] ?? 10);
  if (verb === 'SNOOZE' ? minutes < 1 || minutes > 1440 : match[3] !== undefined)
    return { action: 'invalid' };
  return {
    action: verb === 'SNOOZE' ? 'snooze' : verb === 'CANCEL' ? 'cancel' : 'complete',
    reference: match[2]!.toLowerCase(),
    minutes,
  };
}

export function controlHelp(reference: string): string {
  return `DONE ${reference} / CANCEL ${reference} / SNOOZE ${reference} 10m`;
}
export function controlButtons(reference: string) {
  return [
    { id: `reminder:${reference}:complete`, title: 'Done' },
    { id: `reminder:${reference}:snooze`, title: 'Snooze 10 min' },
    { id: `reminder:${reference}:cancel`, title: 'Cancel' },
  ];
}

/** Caller holds the user/reminder locks inside a transaction. Original plan identity stays authoritative. */
export async function ensureReminderControl(
  client: PoolClient,
  userId: string,
  reminderId: string,
): Promise<string> {
  await client.query(
    `INSERT INTO reminder_controls(user_id,reminder_id,schedule_version,consent_grant_at,timezone_confirmed_at,timezone,expires_at)
    SELECT r.user_id,r.id,r.schedule_version,p.consent_grant_at,p.timezone_confirmed_at,p.timezone,
      GREATEST(r.due_at,clock_timestamp())+interval '30 days'
    FROM reminders r JOIN action_plans p ON p.user_id=r.user_id AND p.event_id=r.source_event_id AND p.version=r.plan_version
    WHERE r.user_id=$1 AND r.id=$2 ON CONFLICT(reminder_id,schedule_version) DO NOTHING`,
    [userId, reminderId],
  );
  return (
    await client.query(
      `SELECT c.reference FROM reminder_controls c JOIN reminders r ON r.user_id=c.user_id AND r.id=c.reminder_id
    AND r.schedule_version=c.schedule_version WHERE r.user_id=$1 AND r.id=$2`,
      [userId, reminderId],
    )
  ).rows[0].reference as string;
}

/** Atomic with the onboarding work lease and identity reply. Never does network I/O. */
export async function applyReminderCommand(
  client: PoolClient,
  eventId: string,
  userId: string,
  command: ReminderCommand,
): Promise<string> {
  const user = (
    await client.query(
      `SELECT u.* FROM users u JOIN ingress_events e
    ON e.phone_number_id=u.business_phone_id AND e.sender_id=u.sender_id
    WHERE u.id=$1 AND e.id=$2 AND e.kind='inbound.message' FOR UPDATE OF u`,
      [userId, eventId],
    )
  ).rows[0];
  if (!user) throw new Error('Reminder command event owner mismatch');
  const replay = (
    await client.query(
      'SELECT reply_text FROM reminder_mutations WHERE event_id=$1 AND user_id=$2',
      [eventId, userId],
    )
  ).rows[0];
  if (replay) return replay.reply_text as string;
  let reply = 'That reminder control is no longer available. Use the latest reminder confirmation.';
  let outcome = command.action === 'invalid' ? 'invalid' : 'stale';
  let reminderId: string | null = null;
  let previous: number | null = null;
  let next: number | null = null;
  if (command.action === 'invalid')
    reply =
      'Use DONE <reference>, CANCEL <reference>, or SNOOZE <reference> 10m (1 to 1440 minutes), using the reference in your latest confirmation.';
  else if (hasOnboarded(user as IdentityState)) {
    const target = (
      await client.query(
        `SELECT r.*,c.reference FROM reminder_controls c
      JOIN reminders r ON r.id=c.reminder_id AND r.user_id=c.user_id JOIN users u ON u.id=r.user_id
      WHERE c.reference=$1 AND c.user_id=$2 AND c.schedule_version=r.schedule_version AND r.status='pending'
        AND c.invalidated_at IS NULL AND c.expires_at>clock_timestamp()
        AND c.consent_grant_at=u.consent_at AND c.timezone_confirmed_at=u.timezone_confirmed_at AND c.timezone=u.timezone
      FOR UPDATE OF r`,
        [command.reference, userId],
      )
    ).rows[0];
    if (target) {
      reminderId = target.id as string;
      previous = target.schedule_version as number;
      next = previous + 1;
      await client.query(
        `UPDATE reminders SET status=$3,schedule_version=schedule_version+1,
        due_at=CASE WHEN $3='pending' THEN clock_timestamp()+$4*interval '1 minute' ELSE due_at END,
        scheduled_at=CASE WHEN $3='pending' THEN NULL ELSE scheduled_at END,
        delivery_mode=CASE WHEN $3='pending' THEN 'immediate' ELSE delivery_mode END,
        promised_due_at=CASE WHEN $3='pending' THEN NULL ELSE promised_due_at END,
        delivery_choice_id=CASE WHEN $3='pending' THEN NULL ELSE delivery_choice_id END WHERE id=$1 AND user_id=$2`,
        [
          reminderId,
          userId,
          command.action === 'snooze'
            ? 'pending'
            : command.action === 'complete'
              ? 'completed'
              : 'cancelled',
          command.minutes,
        ],
      );
      await client.query(
        `UPDATE reminder_controls SET invalidated_at=clock_timestamp() WHERE user_id=$1 AND reminder_id=$2 AND invalidated_at IS NULL`,
        [userId, reminderId],
      );
      await client.query(
        `UPDATE reminder_occurrences SET status='suppressed',suppression_reason='reminder_changed' WHERE user_id=$1 AND reminder_id=$2 AND status='pending'`,
        [userId, reminderId],
      );
      await client.query(
        `UPDATE outbound_messages m SET status='suppressed',suppression_reason='reminder_changed' FROM reminder_occurrences o
        WHERE o.user_id=$1 AND o.reminder_id=$2 AND m.user_id=o.user_id AND m.occurrence_id=o.id AND m.status='pending'`,
        [userId, reminderId],
      );
      const retries = await client.query(
        `UPDATE whatsapp_attempts a SET recovery_state='exhausted',retry_at=NULL,updated_at=clock_timestamp()
        FROM outbound_messages m JOIN reminder_occurrences o ON o.id=m.occurrence_id AND o.user_id=m.user_id
        WHERE o.user_id=$1 AND o.reminder_id=$2 AND a.outbound_message_id=m.id AND a.user_id=m.user_id AND a.recovery_state='retry_wait'
        RETURNING a.id,a.user_id`,
        [userId, reminderId],
      );
      for (const attempt of retries.rows)
        await auditDelivery(client, attempt, 'reminder_invalidated');
      // Suppress a queued creation confirmation that would otherwise describe the old schedule.
      await client.query(
        `UPDATE reply_intents SET status='suppressed' WHERE user_id=$1 AND event_id=$2 AND status='pending'`,
        [userId, target.source_event_id],
      );
      outcome = 'applied';
      reply =
        command.action === 'complete'
          ? 'Reminder marked done.'
          : command.action === 'cancel'
            ? 'Reminder cancelled.'
            : `Reminder snoozed for ${command.minutes} minutes with exact-time delivery (bypassing quiet hours/digest).\n${controlHelp(await ensureReminderControl(client, userId, reminderId))}`;
    }
  }
  await client.query(
    `INSERT INTO reminder_mutations(event_id,user_id,reminder_id,action,outcome,previous_version,new_version,reply_text)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [eventId, userId, reminderId, command.action, outcome, previous, next, reply],
  );
  return reply;
}
