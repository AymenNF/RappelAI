import type { Pool } from 'pg';
import {
  CONSENT_NOTICE,
  CONSENT_VERSION,
  hasOnboarded,
  onboard,
  type IdentityState,
} from './onboarding.js';

export class IdentityProcessor {
  constructor(private readonly pool: Pool) {}

  async processNext(): Promise<{ eventId: string; disposition: string } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // No network calls in this transaction. Only the earliest visible event per sender is eligible.
      const selected = await client.query(`
        SELECT e.*, now() AS db_now FROM ingress_events e
        WHERE e.kind = 'inbound.message'
          AND NOT EXISTS (SELECT 1 FROM identity_results r WHERE r.event_id = e.id)
          AND NOT EXISTS (
            SELECT 1 FROM ingress_events earlier
            WHERE earlier.kind = 'inbound.message' AND earlier.phone_number_id = e.phone_number_id
              AND earlier.sender_id = e.sender_id AND earlier.sequence_no < e.sequence_no
              AND NOT EXISTS (SELECT 1 FROM identity_results r WHERE r.event_id = earlier.id)
          )
        ORDER BY e.sequence_no LIMIT 1 FOR UPDATE OF e SKIP LOCKED
      `);
      const event = selected.rows[0];
      if (!event) {
        await client.query('COMMIT');
        return null;
      }
      await client.query(
        `INSERT INTO users (business_phone_id, sender_id) VALUES ($1,$2)
        ON CONFLICT (business_phone_id,sender_id) DO NOTHING`,
        [event.phone_number_id, event.sender_id],
      );
      const user = (
        await client.query(
          `SELECT * FROM users WHERE business_phone_id=$1 AND sender_id=$2 FOR UPDATE`,
          [event.phone_number_id, event.sender_id],
        )
      ).rows[0];
      const now = event.db_now as Date;
      const timestamp = Number(event.payload.timestamp) * 1000;
      const validTime =
        typeof event.payload.timestamp === 'string' &&
        /^\d+$/.test(event.payload.timestamp) &&
        Number.isSafeInteger(timestamp) &&
        timestamp > 0 &&
        timestamp <= event.received_at.getTime() + 300000;
      const sentAt = new Date(Math.min(timestamp, event.received_at.getTime()));
      const text =
        event.payload.type === 'text' && typeof event.payload.text?.body === 'string'
          ? event.payload.text.body
          : null;
      const transition = validTime
        ? onboard(user as IdentityState, text, sentAt, now)
        : {
            state: user as IdentityState,
            disposition: 'blocked' as const,
            reply: 'Invalid message timestamp. Please send your message again.',
            consentAction: null,
          };
      const s = transition.state;
      await client.query(
        `UPDATE users SET consent_version=$2, consent_at=$3, consent_token=$4,
        consent_expires_at=$5, paused=$6, timezone=$7, timezone_confirmed_at=$8,
        pending_timezone=$9, timezone_token=$10, timezone_expires_at=$11, last_control_at=$12,
        window_expires_at=GREATEST(window_expires_at,$13::timestamptz), consent_offer_version=$14, updated_at=now() WHERE id=$1`,
        [
          user.id,
          s.consent_version,
          s.consent_at,
          s.consent_token,
          s.consent_expires_at,
          s.paused,
          s.timezone,
          s.timezone_confirmed_at,
          s.pending_timezone,
          s.timezone_token,
          s.timezone_expires_at,
          s.last_control_at,
          validTime ? new Date(sentAt.getTime() + 86400000) : null,
          s.consent_offer_version,
        ],
      );
      await client.query(
        `INSERT INTO identity_results(event_id,user_id,disposition,reply_text,consent_grant_at,timezone_confirmed_at)
        VALUES($1,$2,$3,$4,$5,$6)`,
        [
          event.id,
          user.id,
          transition.disposition,
          transition.reply,
          s.consent_at,
          s.timezone_confirmed_at,
        ],
      );
      if (transition.consentAction)
        await client.query(
          `INSERT INTO consent_events(user_id,event_id,action,notice_version,notice_text)
        VALUES($1,$2,$3,$4,$5)`,
          [user.id, event.id, transition.consentAction, CONSENT_VERSION, CONSENT_NOTICE],
        );
      if (transition.disposition !== 'ready') {
        await client.query('UPDATE ingress_events SET processed_at=now() WHERE id=$1', [event.id]);
        await client.query(
          `UPDATE work_outbox SET status='completed', completed_at=now(), lease_token=NULL,lease_until=NULL
          WHERE event_id=$1`,
          [event.id],
        );
      }
      await client.query('COMMIT');
      return { eventId: event.id, disposition: transition.disposition };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // The real model worker must recheck current state, not trust an old 'ready' result.
  async eligibleForProcessing(eventId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT u.* FROM users u JOIN identity_results r ON r.user_id=u.id
      WHERE r.event_id=$1 AND r.disposition='ready'
        AND r.consent_grant_at=u.consent_at AND r.timezone_confirmed_at=u.timezone_confirmed_at`,
      [eventId],
    );
    return !!result.rows[0] && hasOnboarded(result.rows[0] as IdentityState);
  }
}
