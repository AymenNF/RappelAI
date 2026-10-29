import type { Pool } from 'pg';
import type { SendResult } from './send.js';
import { lockProviderMessage, reconcileReceipts } from './receipts.js';
import { auditDelivery, scheduleRetry } from './retry.js';

// All send paths use the receipt lock before acceptance becomes visible.
export async function persistSendResult(pool: Pool, id: string, result: SendResult): Promise<void> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const address = (
      await client.query('SELECT user_id,phone_number_id FROM whatsapp_attempts WHERE id=$1', [id])
    ).rows[0];
    if (!address) throw new Error('Delivery attempt missing');
    // Policy -> user -> provider -> attempt: shared with operator reconciliation.
    await client.query('SELECT singleton FROM usage_policy WHERE singleton FOR UPDATE');
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [address.user_id]);
    if (result.state === 'accepted')
      await lockProviderMessage(client, address.phone_number_id, result.providerMessageId);
    const attempt = (
      await client.query('SELECT * FROM whatsapp_attempts WHERE id=$1 FOR UPDATE', [id])
    ).rows[0];
    if (
      attempt.state !== 'dispatching' &&
      !(
        attempt.state === 'unknown' &&
        attempt.resolution === null &&
        attempt.recovery_state === 'none'
      )
    ) {
      if (
        result.state === 'accepted' &&
        (attempt.state !== 'accepted' || attempt.provider_message_id !== result.providerMessageId)
      ) {
        // Contradictory late evidence must not silently overwrite an operator decision or a retry.
        await client.query(
          'UPDATE usage_policy SET enabled=false,updated_at=clock_timestamp() WHERE singleton',
        );
        await auditDelivery(client, attempt, 'late_acceptance_conflict', {
          providerMessageId: result.providerMessageId,
        });
      }
      await client.query('COMMIT');
      return;
    }
    await client.query(
      `UPDATE whatsapp_attempts SET state=$2,provider_message_id=$3,error_code=$4,updated_at=clock_timestamp()
        WHERE id=$1`,
      [
        id,
        result.state,
        result.state === 'accepted' ? result.providerMessageId : null,
        result.state === 'accepted' ? null : result.code,
      ],
    );
    await auditDelivery(client, attempt, 'send_result', {
      state: result.state,
      code: result.state === 'accepted' ? null : result.code,
    });
    if (result.state === 'rejected' && result.retryable)
      await scheduleRetry(client, attempt, result.retryAfterSeconds);
    if (result.state === 'accepted')
      await reconcileReceipts(client, attempt.phone_number_id, result.providerMessageId);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    // A lost/failed persistence leaves dispatching durable, which blocks automatic redispatch.
    throw error;
  } finally {
    client.release(discard);
  }
}
