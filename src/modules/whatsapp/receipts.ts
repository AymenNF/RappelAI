import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { WorkHandler } from '../processing/runner.js';
import { PermanentWorkError } from '../processing/runner.js';
import { LeaseLostError, type WorkLease, type WorkTransition } from '../processing/leases.js';

export type DeliveryStatus = 'none' | 'sent' | 'failed' | 'delivered' | 'read';
const rank: Record<DeliveryStatus, number> = { none: 0, sent: 1, failed: 2, delivered: 3, read: 4 };
export function reduceDelivery(current: DeliveryStatus, statuses: string[]): DeliveryStatus {
  for (const status of statuses)
    if (Object.hasOwn(rank, status) && rank[status as DeliveryStatus] > rank[current])
      current = status as DeliveryStatus;
  return current;
}
export async function lockProviderMessage(
  client: PoolClient,
  phone: string,
  message: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    JSON.stringify(['whatsapp-receipt', phone, message]),
  ]);
}
// Caller holds the provider-message lock, shared with send-result persistence. Handles early receipts.
export async function reconcileReceipts(
  client: PoolClient,
  phone: string,
  message: string,
): Promise<void> {
  const attempt = (
    await client.query(
      `SELECT * FROM whatsapp_attempts
    WHERE phone_number_id=$1 AND provider_message_id=$2 FOR UPDATE`,
      [phone, message],
    )
  ).rows[0];
  if (!attempt) return;
  await client.query(
    `UPDATE whatsapp_receipts SET attempt_id=$3,user_id=$4
    WHERE phone_number_id=$1 AND provider_message_id=$2 AND recipient_id=$5 AND attempt_id IS NULL`,
    [phone, message, attempt.id, attempt.user_id, attempt.recipient_id],
  );
  const receipts = await client.query('SELECT status FROM whatsapp_receipts WHERE attempt_id=$1', [
    attempt.id,
  ]);
  const status = reduceDelivery(
    attempt.delivery_status,
    receipts.rows.map((r) => r.status),
  );
  await client.query(
    'UPDATE whatsapp_attempts SET delivery_status=$2,updated_at=clock_timestamp() WHERE id=$1',
    [attempt.id, status],
  );
}

const receiptSchema = z.object({
  id: z.string().min(1).max(512),
  recipient_id: z.string().min(1).max(100),
  status: z.string().min(1).max(50),
  timestamp: z.string().regex(/^\d{1,12}$/),
});
export class ReceiptProcessor implements WorkHandler<null> {
  async prepare(lease: WorkLease, signal: AbortSignal): Promise<null> {
    if (lease.stage !== 'receipt') throw new PermanentWorkError('Expected receipt stage');
    if (signal.aborted) throw new LeaseLostError();
    return null;
  }
  async apply(client: PoolClient, lease: WorkLease): Promise<WorkTransition> {
    if (lease.stage !== 'receipt') throw new PermanentWorkError('Expected receipt stage');
    const event = (
      await client.query("SELECT * FROM ingress_events WHERE id=$1 AND kind='delivery.status'", [
        lease.event_id,
      ])
    ).rows[0];
    const parsed = receiptSchema.safeParse(event?.payload);
    if (!event || !parsed.success || parsed.data.id !== event.provider_message_id)
      throw new PermanentWorkError('Invalid receipt');
    const receipt = parsed.data;
    const time = Number(receipt.timestamp) * 1000;
    if (!Number.isSafeInteger(time) || time <= 0 || time > event.received_at.getTime() + 300000)
      throw new PermanentWorkError('Invalid receipt timestamp');
    await lockProviderMessage(client, event.phone_number_id, receipt.id);
    await client.query(
      `INSERT INTO whatsapp_receipts(event_id,phone_number_id,provider_message_id,recipient_id,status,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_id) DO NOTHING`,
      [
        event.id,
        event.phone_number_id,
        receipt.id,
        receipt.recipient_id,
        receipt.status,
        new Date(time),
      ],
    );
    await reconcileReceipts(client, event.phone_number_id, receipt.id);
    return { nextStage: null };
  }
}
