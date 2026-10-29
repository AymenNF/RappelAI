import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { auditDelivery, scheduleRetry } from './retry.js';
import { lockProviderMessage, reconcileReceipts } from './receipts.js';

const note = z.string().trim().min(1).max(500);
export const reconciliation = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('accepted'),
      note,
      phoneNumberId: z.string().regex(/^\d{1,30}$/),
      recipientId: z.string().regex(/^\d{5,20}$/),
      providerMessageId: z.string().min(1).max(512),
    })
    .strict(),
  z.object({ action: z.literal('not_sent'), note, senderStopped: z.literal(true) }).strict(),
  z.object({ action: z.enum(['abandon', 'retry']), note }).strict(),
]);
async function assertOperator(client: PoolClient) {
  if (
    !(
      await client.query(
        "SELECT pg_has_role(current_user,relowner,'MEMBER') AS allowed FROM pg_class WHERE oid='whatsapp_attempts'::regclass",
      )
    ).rows[0]?.allowed
  )
    throw new Error('Delivery reconciliation requires the migration administrator');
}

export class DeliveryRecovery {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      const result = await operation(client);
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

  /** Local recovery only: expired dispatches become unknown, never safe-to-retry by age alone. */
  async recover(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Recovery limit must be 1-500');
    return this.transaction(async (client) => {
      const rows = await client.query(
        `SELECT * FROM whatsapp_attempts WHERE
        (state='dispatching' AND dispatch_deadline<=clock_timestamp()) OR
        (recovery_state='retry_wait' AND retry_until<=clock_timestamp())
        ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      for (const attempt of rows.rows) {
        if (attempt.state === 'dispatching') {
          await client.query(
            "UPDATE whatsapp_attempts SET state='unknown',error_code='dispatch_expired',updated_at=clock_timestamp() WHERE id=$1",
            [attempt.id],
          );
          await auditDelivery(client, attempt, 'dispatch_expired');
        } else {
          await client.query(
            "UPDATE whatsapp_attempts SET recovery_state='exhausted',retry_at=NULL,updated_at=clock_timestamp() WHERE id=$1",
            [attempt.id],
          );
          await auditDelivery(client, attempt, 'retry_expired');
        }
      }
      return rows.rowCount ?? 0;
    });
  }

  async reconcile(id: string, input: unknown): Promise<void> {
    z.uuid().parse(id);
    const decision = reconciliation.parse(input);
    await this.transaction(async (client) => {
      await assertOperator(client);
      await client.query('SELECT singleton FROM usage_policy WHERE singleton FOR UPDATE');
      const address = (
        await client.query(
          'SELECT user_id,phone_number_id,recipient_id FROM whatsapp_attempts WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!address) throw new Error('Delivery attempt missing');
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [address.user_id]);
      if (decision.action === 'accepted') {
        if (
          decision.phoneNumberId !== address.phone_number_id ||
          decision.recipientId !== address.recipient_id
        )
          throw new Error('Evidence address mismatch');
        await lockProviderMessage(client, address.phone_number_id, decision.providerMessageId);
      }
      const attempt = (
        await client.query(
          'SELECT *,dispatch_deadline<=clock_timestamp() AS expired FROM whatsapp_attempts WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (
        attempt.resolution === decision.action ||
        (decision.action === 'abandon' && attempt.resolution === 'abandoned')
      ) {
        if (
          decision.action === 'accepted' &&
          attempt.provider_message_id !== decision.providerMessageId
        )
          throw new Error('Conflicting provider evidence');
        return; // Exact semantic replay is a no-op, including its audit record.
      }
      if (
        (await client.query('SELECT 1 FROM whatsapp_attempts WHERE previous_attempt_id=$1', [id]))
          .rowCount
      )
        throw new Error('Only the latest attempt can be reconciled');
      if (decision.action === 'accepted') {
        if (
          attempt.state === 'accepted' &&
          attempt.provider_message_id === decision.providerMessageId
        )
          return;
        if (
          !['unknown', 'dispatching'].includes(attempt.state) ||
          (attempt.resolution !== null && attempt.resolution !== 'abandoned')
        )
          throw new Error('Attempt already resolved');
        const evidence = await client.query(
          'SELECT recipient_id FROM whatsapp_receipts WHERE phone_number_id=$1 AND provider_message_id=$2',
          [address.phone_number_id, decision.providerMessageId],
        );
        if (
          evidence.rowCount &&
          !evidence.rows.some((row) => row.recipient_id === address.recipient_id)
        )
          throw new Error('Receipt evidence address mismatch');
        await client.query(
          "UPDATE whatsapp_attempts SET state='accepted',provider_message_id=$2,error_code=NULL,resolution='accepted',recovery_state='none',retry_at=NULL,updated_at=clock_timestamp() WHERE id=$1",
          [id, decision.providerMessageId],
        );
        await reconcileReceipts(client, address.phone_number_id, decision.providerMessageId);
      } else if (decision.action === 'retry') {
        if (
          attempt.state !== 'rejected' ||
          attempt.provider_message_id !== null ||
          ['retried', 'abandoned', 'exhausted'].includes(attempt.recovery_state)
        )
          throw new Error('Only a definite rejection can be retried');
        if (attempt.recovery_state === 'retry_wait') return;
        // Never insert an old retry behind a newer authorized send in the same stream.
        await this.assertNoLaterSend(client, attempt);
        await scheduleRetry(client, attempt);
      } else {
        if (
          !['unknown', 'dispatching'].includes(attempt.state) ||
          attempt.resolution !== null ||
          !attempt.expired
        )
          throw new Error('Unresolved attempt must pass its dispatch deadline first');
        if (decision.action === 'not_sent') {
          await this.assertNoLaterSend(client, attempt);
          await client.query(
            "UPDATE whatsapp_attempts SET state='rejected',error_code='operator_not_sent',resolution='not_sent',updated_at=clock_timestamp() WHERE id=$1",
            [id],
          );
          await scheduleRetry(client, attempt);
        } else
          await client.query(
            "UPDATE whatsapp_attempts SET resolution='abandoned',recovery_state='abandoned',updated_at=clock_timestamp() WHERE id=$1",
            [id],
          );
      }
      await auditDelivery(client, attempt, `operator_${decision.action}`, {
        ...decision,
        before: {
          state: attempt.state,
          code: attempt.error_code,
          recoveryState: attempt.recovery_state,
        },
      });
    });
  }
  private async assertNoLaterSend(client: PoolClient, attempt: { id: string; user_id: string }) {
    if (
      (
        await client.query(
          `SELECT 1 FROM whatsapp_attempts WHERE user_id=$1 AND created_at>(SELECT created_at FROM whatsapp_attempts WHERE id=$2) AND id<>$2 AND state<>'suppressed' LIMIT 1`,
          [attempt.user_id, attempt.id],
        )
      ).rowCount
    )
      throw new Error('A later send already exists; do not retry an older message');
  }
  async status(limit = 100): Promise<unknown> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Status limit must be 1-500');
    return this.transaction(async (client) => {
      await assertOperator(client);
      return (
        await client.query(
          `WITH statuses AS (SELECT a.*,EXISTS(SELECT 1 FROM delivery_recovery_audit conflict
            WHERE conflict.attempt_id=a.id AND conflict.action='late_acceptance_conflict'
            AND NOT EXISTS(SELECT 1 FROM delivery_recovery_audit resolved WHERE resolved.attempt_id=a.id
              AND resolved.action='operator_accepted' AND resolved.created_at>conflict.created_at)) AS unresolved_conflict
            FROM whatsapp_attempts a)
          SELECT id,user_id,event_id,outbound_message_id,attempt_no,state,recovery_state,resolution,
        delivery_status,error_code,dispatch_deadline,retry_at,retry_until,provider_message_id,unresolved_conflict
        FROM statuses WHERE (state IN ('dispatching','unknown') AND recovery_state<>'abandoned')
        OR recovery_state IN ('retry_wait','exhausted') OR unresolved_conflict ORDER BY created_at,id LIMIT $1`,
          [limit],
        )
      ).rows;
    });
  }
}
