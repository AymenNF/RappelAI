import type { PoolClient } from 'pg';
import { reminderCommand } from '../reminders/controls.js';

type Policy = Record<string, number>;
/** Call inside the authorizing transaction, with the owner user row already locked. */
export async function quotaState(client: PoolClient, userId: string) {
  await client.query(
    "SELECT pg_advisory_xact_lock_shared(hashtextextended(current_schema()||':quota-policy',0))",
  );
  const policy = (await client.query('SELECT * FROM quota_policy WHERE singleton')).rows[0] as
    Policy | undefined;
  if (!policy) throw new Error('Quota policy missing');
  const blocked = !!(
    await client.query('SELECT blocked FROM quota_accounts WHERE user_id=$1', [userId])
  ).rows[0]?.blocked;
  return { policy, blocked };
}
async function clock(client: PoolClient) {
  return (
    await client.query(`WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS now)
    SELECT date_trunc('minute',now)::text AS minute,
    (date_trunc('day',now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::text AS day FROM instant`)
  ).rows[0] as { minute: string; day: string };
}
/** Fixed UTC windows; all slots are checked before any increment. No refund after authorization. */
export async function consumeQuota(
  client: PoolClient,
  userId: string,
  kind: 'requests' | 'model' | 'send' | 'notice' | 'status',
): Promise<string | null> {
  const { policy, blocked } = await quotaState(client, userId);
  if (blocked && !['notice', 'status'].includes(kind)) return 'account_blocked';
  if (kind === 'model' || kind === 'send')
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':quota-global:'||$1,0))",
      [kind],
    );
  const periods = await clock(client);
  const metrics =
    kind === 'notice' || kind === 'status' ? [`${kind}_minute`] : [`${kind}_minute`, `${kind}_day`];
  const global = kind === 'model' || kind === 'send' ? `global_${kind}_day` : null;
  if (global) {
    await client.query(
      'INSERT INTO quota_global_counters(metric,period) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [global, periods.day],
    );
    const row = (
      await client.query(
        'SELECT used FROM quota_global_counters WHERE metric=$1 AND period=$2 FOR UPDATE',
        [global, periods.day],
      )
    ).rows[0];
    if (row.used >= policy[global]!) return global;
  }
  for (const metric of metrics) {
    const period = metric.endsWith('_minute') ? periods.minute : periods.day;
    await client.query(
      'INSERT INTO quota_counters(user_id,metric,period) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [userId, metric, period],
    );
    const row = (
      await client.query(
        'SELECT used FROM quota_counters WHERE user_id=$1 AND metric=$2 AND period=$3 FOR UPDATE',
        [userId, metric, period],
      )
    ).rows[0];
    if (row.used >= (kind === 'notice' || kind === 'status' ? 1 : policy[metric]!)) return metric;
  }
  for (const metric of metrics)
    await client.query(
      'UPDATE quota_counters SET used=used+1 WHERE user_id=$1 AND metric=$2 AND period=$3',
      [userId, metric, metric.endsWith('_minute') ? periods.minute : periods.day],
    );
  if (global)
    await client.query(
      'UPDATE quota_global_counters SET used=used+1 WHERE metric=$1 AND period=$2',
      [global, periods.day],
    );
  return null;
}
export function rejectionMessage(reason: string): string {
  if (reason === 'account_blocked')
    return 'New requests are restricted on this account. STOP and reminder DONE/CANCEL remain available. Contact the operator for review.';
  if (reason === 'input_size')
    return 'That message is too long (maximum 4,096 characters). Please shorten it and resend. Nothing was applied.';
  return `Request limit reached. Nothing was applied or queued for later. Retry ${reason.endsWith('_day') ? 'after 00:00 UTC' : 'after the next minute begins'}. Send QUOTA for your limits. STOP and reminder DONE/CANCEL remain available.`;
}
export async function quotaSummary(client: PoolClient, userId: string): Promise<string> {
  const { policy, blocked } = await quotaState(client, userId),
    periods = await clock(client);
  const counts = (
    await client.query(
      `SELECT metric,used FROM quota_counters WHERE user_id=$1 AND ((metric LIKE '%_minute' AND period=$2::timestamptz) OR (metric LIKE '%_day' AND period=$3::timestamptz))`,
      [userId, periods.minute, periods.day],
    )
  ).rows;
  // At midnight minute/day periods can coincide; metric keys still distinguish them.
  const used = Object.fromEntries(counts.map((r) => [r.metric, r.used]));
  const inventory = (
    await client.query(
      `SELECT (SELECT count(*) FROM reminders WHERE user_id=$1 AND status='pending') AS reminders,
    (SELECT count(*) FROM list_items WHERE user_id=$1) AS items`,
      [userId],
    )
  ).rows[0];
  const enabled = (await client.query('SELECT enabled FROM usage_policy WHERE singleton')).rows[0]
    ?.enabled;
  return `${blocked ? 'Account restricted.\n' : ''}Your limits (UTC):\nRequests: ${used.requests_minute ?? 0}/${policy.requests_minute} this minute; ${used.requests_day ?? 0}/${policy.requests_day} today.\nModel attempts: ${used.model_minute ?? 0}/${policy.model_minute} this minute; ${used.model_day ?? 0}/${policy.model_day} today.\nSend attempts: ${used.send_minute ?? 0}/${policy.send_minute} this minute; ${used.send_day ?? 0}/${policy.send_day} today.\nPending reminders: ${inventory.reminders}/${policy.pending_reminders}. Stored list items (including done): ${inventory.items}/${policy.list_items}.\nMinute limits reset at the next minute; daily limits at 00:00 UTC. Attempts include retries and uncertain outcomes. Rejected requests are not retried automatically. Model/send work already queued waits for limits; exact-time delivery may be missed. ${enabled ? 'Spending and shared service caps also apply.' : 'Model calls and sends are globally paused.'} STOP and reminder DONE/CANCEL remain available.`;
}
export async function admitRequest(
  client: PoolClient,
  eventId: string,
  userId: string,
  text: string | null,
  payload: Record<string, unknown>,
) {
  const old = (
    await client.query(
      'SELECT allowed,reply_text FROM request_admissions WHERE event_id=$1 AND user_id=$2',
      [eventId, userId],
    )
  ).rows[0];
  if (old) return old as { allowed: boolean; reply_text: string | null };
  const command = reminderCommand(payload);
  const safety =
    text?.trim().toUpperCase() === 'STOP' ||
    (command && command.action !== 'invalid' && ['cancel', 'complete'].includes(command.action));
  let reason = 'allowed',
    reply: string | null = null,
    allowed = true;
  if (text?.trim().toUpperCase() === 'QUOTA') {
    reason = 'status';
    allowed = false;
    if (!(await consumeQuota(client, userId, 'status'))) reply = await quotaSummary(client, userId);
  } else if (!safety) {
    const denied =
      text && text.length > 4096 ? 'input_size' : await consumeQuota(client, userId, 'requests');
    if (denied) {
      allowed = false;
      reason = denied;
      if (!(await consumeQuota(client, userId, 'notice'))) reply = rejectionMessage(denied);
    }
  }
  await client.query(
    'INSERT INTO request_admissions(event_id,user_id,allowed,reason,reply_text) VALUES($1,$2,$3,$4,$5)',
    [eventId, userId, allowed, reason, reply],
  );
  return { allowed, reply_text: reply };
}
export async function inventoryDenial(
  client: PoolClient,
  userId: string,
  reminders: number,
  items: number,
): Promise<string | null> {
  const { policy, blocked } = await quotaState(client, userId);
  if (blocked)
    return 'This account is restricted. Nothing from this request was saved. STOP and reminder DONE/CANCEL remain available.';
  const counts = (
    await client.query(
      `SELECT (SELECT count(*)::integer FROM reminders WHERE user_id=$1 AND status='pending') AS reminders,
    (SELECT count(*)::integer FROM list_items WHERE user_id=$1) AS items`,
      [userId],
    )
  ).rows[0];
  if (reminders > 0 && counts.reminders + reminders > policy.pending_reminders!)
    return `Pending reminder limit (${policy.pending_reminders}) reached. Complete or cancel reminders, then retry. Nothing from this request was saved.`;
  if (items > 0 && counts.items + items > policy.list_items!)
    return `Stored list-item limit (${policy.list_items}) reached. Marking an item done does not free storage. Contact the operator about capacity. Nothing from this request was saved.`;
  return null;
}
