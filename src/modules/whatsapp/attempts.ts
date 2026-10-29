import type { Pool } from 'pg';
import type { SendResult } from './send.js';
import { lockProviderMessage, reconcileReceipts } from './receipts.js';

// All send paths use the receipt lock before acceptance becomes visible.
export async function persistSendResult(pool: Pool, id: string, result: SendResult): Promise<void> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const attempt = (await client.query('SELECT * FROM whatsapp_attempts WHERE id=$1', [id]))
      .rows[0];
    if (result.state === 'accepted')
      await lockProviderMessage(client, attempt.phone_number_id, result.providerMessageId);
    await client.query(
      `UPDATE whatsapp_attempts SET state=$2,provider_message_id=$3,error_code=$4,updated_at=clock_timestamp()
        WHERE id=$1 AND state='dispatching'`,
      [
        id,
        result.state,
        result.state === 'accepted' ? result.providerMessageId : null,
        result.state === 'accepted' ? null : result.code,
      ],
    );
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
