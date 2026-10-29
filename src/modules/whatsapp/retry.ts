import type { PoolClient } from 'pg';

export const MAX_DELIVERY_ATTEMPTS = 3;
export function deliveryRetryDelay(attemptNo: number): number {
  if (!Number.isInteger(attemptNo) || attemptNo < 1 || attemptNo > MAX_DELIVERY_ATTEMPTS)
    throw new Error('Invalid delivery attempt number');
  return Math.min(900, 60 * 4 ** (attemptNo - 1));
}
export interface Attempt {
  id: string;
  user_id: string;
  state: string;
  recovery_state: string;
  attempt_no: number;
  retry_until: string;
  retry_at: Date | null;
  retry_due: boolean;
  retry_expired: boolean;
  provider_message_id: string | null;
  resolution: string | null;
}
export async function auditDelivery(
  client: PoolClient,
  attempt: { id: string; user_id: string },
  action: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    'INSERT INTO delivery_recovery_audit(user_id,attempt_id,action,details) VALUES($1,$2,$3,$4)',
    [attempt.user_id, attempt.id, action, details],
  );
}
// Caller holds the user lock. Exact retry horizon stays in PostgreSQL text, not JS milliseconds.
export async function latestAttempt(
  client: PoolClient,
  source: 'event_id' | 'outbound_message_id',
  id: string,
): Promise<Attempt | undefined> {
  return (
    await client.query(
      `SELECT *,retry_until::text AS retry_until,
    retry_at<=clock_timestamp() AS retry_due,retry_until<=clock_timestamp() AS retry_expired
    FROM whatsapp_attempts WHERE ${source}=$1 ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`,
      [id],
    )
  ).rows[0];
}
export async function expireRetry(client: PoolClient, attempt: Attempt): Promise<void> {
  await client.query(
    "UPDATE whatsapp_attempts SET recovery_state='exhausted',retry_at=NULL,updated_at=clock_timestamp() WHERE id=$1",
    [attempt.id],
  );
  await auditDelivery(client, attempt, 'retry_exhausted');
}
export async function scheduleRetry(
  client: PoolClient,
  attempt: { id: string; user_id: string; attempt_no: number },
  minimumDelay = 0,
): Promise<void> {
  if (!Number.isInteger(minimumDelay) || minimumDelay < 0 || minimumDelay > 2147483647)
    throw new Error('Invalid retry delay');
  // A transport result or operator reconciliation can arrive after a reminder was changed.
  // Preserve the evidence, but never put its invalidated intent back into the retry queue.
  const invalidated = await client.query(
    `SELECT 1 FROM whatsapp_attempts a
    JOIN outbound_messages m ON m.id=a.outbound_message_id AND m.user_id=a.user_id
    JOIN reminder_occurrences o ON o.id=m.occurrence_id AND o.user_id=m.user_id
    JOIN reminders r ON r.id=o.reminder_id AND r.user_id=o.user_id
    WHERE a.id=$1 AND (m.status<>'pending' OR o.status<>'pending' OR r.status<>'pending'
      OR o.schedule_version<>r.schedule_version OR o.original_due_at<>r.due_at)`,
    [attempt.id],
  );
  if (invalidated.rowCount) {
    await client.query(
      "UPDATE whatsapp_attempts SET recovery_state='exhausted',retry_at=NULL,updated_at=clock_timestamp() WHERE id=$1",
      [attempt.id],
    );
    await auditDelivery(client, attempt, 'reminder_invalidated');
    return;
  }
  const row = (
    await client.query(
      `WITH timing AS (SELECT clock_timestamp() AS at) UPDATE whatsapp_attempts SET
    recovery_state=CASE WHEN attempt_no<3 AND retry_until>timing.at+$2*interval '1 second' THEN 'retry_wait' ELSE 'exhausted' END,
    retry_at=CASE WHEN attempt_no<3 AND retry_until>timing.at+$2*interval '1 second' THEN timing.at+$2*interval '1 second' ELSE NULL END,
    updated_at=timing.at FROM timing WHERE id=$1 RETURNING recovery_state`,
      [attempt.id, Math.max(minimumDelay, deliveryRetryDelay(attempt.attempt_no))],
    )
  ).rows[0];
  await auditDelivery(
    client,
    attempt,
    row.recovery_state === 'retry_wait' ? 'retry_scheduled' : 'retry_exhausted',
  );
}
