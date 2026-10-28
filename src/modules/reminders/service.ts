import type { PoolClient } from 'pg';
import { reminderArgs } from '../../contracts/decision.js';
import {
  actionResult,
  ExpiredReminderError,
  type ActionResult,
  type ActionSource,
} from '../processing/results.js';

export async function createReminder(
  client: PoolClient,
  source: ActionSource,
  input: unknown,
  timezone: string,
): Promise<ActionResult> {
  const args = reminderArgs.parse(input);
  if (args.delivery_mode !== 'immediate') throw new Error('Digest reminders are not implemented');
  const old = (
    await client.query('SELECT * FROM reminders WHERE user_id=$1 AND action_key=$2', [
      source.userId,
      source.key,
    ])
  ).rows[0];
  if (old)
    return actionResult.parse({
      tool: 'create_reminder',
      id: old.id,
      title: old.title,
      dueAt: old.due_at.toISOString(),
      timezone: old.timezone,
    });
  const row = (
    await client.query(
      `INSERT INTO reminders(user_id,source_event_id,plan_version,action_key,title,due_at,timezone,delivery_mode)
    SELECT $1,$2,$3,$4,$5,$6,$7,'immediate' WHERE $6::timestamptz>clock_timestamp() RETURNING *`,
      [
        source.userId,
        source.eventId,
        source.version,
        source.key,
        args.title,
        args.due_at,
        timezone,
      ],
    )
  ).rows[0];
  if (!row) throw new ExpiredReminderError('Reminder expired before insertion');
  return actionResult.parse({
    tool: 'create_reminder',
    id: row.id,
    title: row.title,
    dueAt: row.due_at.toISOString(),
    timezone: row.timezone,
  });
}
