import type { Pool } from 'pg';
import type { IngressEvent } from '../modules/whatsapp/events.js';

export interface IngressStore {
  persist(events: IngressEvent[]): Promise<{ inserted: number }>;
  ready(): Promise<boolean>;
}

export class PostgresIngressStore implements IngressStore {
  constructor(private readonly pool: Pool) {}

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
    if (events.length === 0) return { inserted: 0 };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // One statement for the batch; the inbox and durable work intent commit together.
      const result = await client.query(
        `
        WITH incoming AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS e(
            event_key text, kind text, phone_number_id text,
            provider_message_id text, sender_id text, payload jsonb
          )
        ), inserted AS (
          INSERT INTO ingress_events
            (event_key, kind, phone_number_id, provider_message_id, sender_id, payload)
          SELECT event_key, kind, phone_number_id, provider_message_id, sender_id, payload
          FROM incoming ON CONFLICT (event_key) DO NOTHING RETURNING id, kind
        )
        INSERT INTO work_outbox (event_id, topic)
        SELECT id, kind FROM inserted RETURNING id
      `,
        [
          JSON.stringify(
            events.map((e) => ({
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
