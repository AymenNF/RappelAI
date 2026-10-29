import type { Pool } from 'pg';
import type { IngressEvent } from '../modules/whatsapp/events.js';
import { reminderCommand } from '../modules/reminders/controls.js';

export class IngressCapacityError extends Error {}
export class IngressBatchError extends Error {}

export interface IngressStore {
  persist(events: IngressEvent[]): Promise<{ inserted: number }>;
  ready(): Promise<boolean>;
}

export class PostgresIngressStore implements IngressStore {
  constructor(
    private readonly pool: Pool,
    private readonly maxPending = 10000,
  ) {
    if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 100000)
      throw new Error('Invalid ingress capacity');
  }

  async ready(): Promise<boolean> {
    try {
      await this.pool.query('SELECT event_key FROM ingress_events LIMIT 0');
      await this.pool.query('SELECT event_id FROM work_outbox LIMIT 0');
      return true;
    } catch {
      return false;
    }
  }

  async persist(events: IngressEvent[]): Promise<{ inserted: number }> {
    if (events.length > 1000) throw new IngressBatchError('Webhook event batch exceeds 1000');
    if (events.length === 0) return { inserted: 0 };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize insertion/commit per provider stream BEFORE allocating identity sequence values.
      // Sorting multi-stream batches prevents opposing lock acquisition order.
      const streams = [
        ...new Set(
          events.map((e) =>
            JSON.stringify([e.phoneNumberId, e.kind, e.senderId ?? e.providerMessageId]),
          ),
        ),
      ].sort();
      for (const stream of streams) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [stream]);
      }
      const normal = events.filter((e) => {
        if (e.kind === 'delivery.status') return false;
        const command = reminderCommand(e.payload);
        const stop =
          e.payload.type === 'text' &&
          typeof e.payload.text === 'object' &&
          e.payload.text !== null &&
          typeof (e.payload.text as { body?: unknown }).body === 'string' &&
          (e.payload.text as { body: string }).body.trim().toUpperCase() === 'STOP';
        return (
          !stop &&
          !(
            command &&
            command.action !== 'invalid' &&
            ['cancel', 'complete'].includes(command.action)
          )
        );
      });
      if (normal.length) {
        // Shared across API processes. Replay needs no capacity; receipts and safety controls drain work.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':ingress-capacity',0))",
        );
        const fresh = (
          await client.query(
            'SELECT count(*)::integer AS n FROM (SELECT DISTINCT unnest($1::text[]) AS key) x WHERE NOT EXISTS(SELECT 1 FROM ingress_events WHERE event_key=x.key)',
            [normal.map((e) => e.eventKey)],
          )
        ).rows[0].n;
        if (fresh) {
          const pending = (
            await client.query(
              "SELECT count(*)::integer AS n FROM (SELECT id FROM work_outbox WHERE status<>'completed' AND stage<>'receipt' LIMIT $1) q",
              [this.maxPending],
            )
          ).rows[0].n;
          if (pending + fresh > this.maxPending)
            throw new IngressCapacityError('Inbound queue capacity reached');
        }
      }
      // One statement for the batch; the inbox and durable work intent commit together.
      const result = await client.query(
        `
        WITH incoming AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS e(
            event_key text, kind text, phone_number_id text,
            provider_message_id text, sender_id text, payload jsonb, batch_position integer
          )
        ), inserted AS (
          INSERT INTO ingress_events
            (event_key, kind, phone_number_id, provider_message_id, sender_id, payload)
          SELECT event_key, kind, phone_number_id, provider_message_id, sender_id, payload
          FROM incoming ORDER BY batch_position ON CONFLICT (event_key) DO NOTHING RETURNING id, kind
        )
        INSERT INTO work_outbox (event_id, topic, stage)
        SELECT id, kind, CASE WHEN kind='delivery.status' THEN 'receipt' ELSE 'onboarding' END FROM inserted RETURNING id
      `,
        [
          JSON.stringify(
            events.map((e, index) => ({
              batch_position: index,
              event_key: e.eventKey,
              kind: e.kind,
              phone_number_id: e.phoneNumberId,
              provider_message_id: e.providerMessageId,
              sender_id: e.senderId,
              payload: e.payload,
            })),
          ),
        ],
      );
      await client.query('COMMIT');
      return { inserted: result.rowCount ?? 0 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
