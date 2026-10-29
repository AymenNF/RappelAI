import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { WorkQueue, type WorkTransition } from '../processing/leases.js';
import { applyReminderCommand, reminderCommand } from '../reminders/controls.js';
import { seriesCommand } from '../reminders/recurrence.js';
import { applySeriesCommand } from '../reminders/series.js';
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
    const queue = new WorkQueue(this.pool);
    const lease = await queue.claim('onboarding', `simulator-${randomUUID()}`);
    if (!lease) return null;
    let disposition = '';
    try {
      await queue.commit(lease, async (client) => {
        const result = await this.apply(client, lease.event_id);
        disposition = result.disposition;
        return result;
      });
      return { eventId: lease.event_id, disposition };
    } catch (error) {
      await queue.fail(lease, 'handler_failed');
      throw error;
    }
  }

  async apply(
    client: PoolClient,
    eventId: string,
  ): Promise<WorkTransition & { disposition: string }> {
    const selected = await client.query(
      "SELECT e.*, clock_timestamp() AS db_now FROM ingress_events e WHERE id=$1 AND kind='inbound.message'",
      [eventId],
    );
    const event = selected.rows[0];
    if (!event) throw new Error('Onboarding event missing');
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
    const command = reminderCommand(event.payload);
    const recurrence = seriesCommand(text);
    const transition = validTime
      ? onboard(user as IdentityState, command && !text ? 'reminder control' : text, sentAt, now)
      : {
          state: user as IdentityState,
          disposition: 'blocked' as const,
          reply: 'Invalid message timestamp. Please send your message again.',
          consentAction: null,
        };
    const s = transition.state;
    if (recurrence && transition.disposition === 'ready') {
      transition.reply = await applySeriesCommand(client, event.id, user.id, recurrence);
      transition.disposition = 'handled';
    } else if (command && transition.disposition === 'ready') {
      transition.reply = await applyReminderCommand(client, event.id, user.id, command);
      transition.disposition = 'handled';
    }
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
    // A later STOP or settings change must suppress an already queued plan reply.
    await client.query(
      `UPDATE reply_intents SET status='suppressed' WHERE user_id=$1 AND status='pending'
      AND ($2::boolean OR consent_grant_at IS DISTINCT FROM $3::timestamptz
        OR timezone_confirmed_at IS DISTINCT FROM $4::timestamptz)`,
      [user.id, !hasOnboarded(s), s.consent_at, s.timezone_confirmed_at],
    );
    // The scheduler takes the same user lock. STOP/settings changes invalidate queued reminders too.
    await client.query(
      `UPDATE reminder_series SET status='suppressed',updated_at=clock_timestamp()
      WHERE user_id=$1 AND status IN ('proposed','active') AND ($2::boolean
        OR consent_grant_at IS DISTINCT FROM $3::timestamptz OR timezone_confirmed_at IS DISTINCT FROM $4::timestamptz)`,
      [user.id, !hasOnboarded(s), s.consent_at, s.timezone_confirmed_at],
    );
    await client.query(
      `UPDATE reminder_controls SET invalidated_at=clock_timestamp() WHERE user_id=$1 AND invalidated_at IS NULL
        AND ($2::boolean OR consent_grant_at IS DISTINCT FROM $3::timestamptz
          OR timezone_confirmed_at IS DISTINCT FROM $4::timestamptz)`,
      [user.id, !hasOnboarded(s), s.consent_at, s.timezone_confirmed_at],
    );
    await client.query(
      `WITH invalidated AS (
        UPDATE outbound_messages SET status='suppressed',suppression_reason='identity_changed'
        WHERE user_id=$1 AND status='pending'
          AND ($2::boolean OR consent_grant_at IS DISTINCT FROM $3::timestamptz
            OR timezone_confirmed_at IS DISTINCT FROM $4::timestamptz)
        RETURNING occurrence_id
      ) UPDATE reminder_occurrences o SET status='suppressed',suppression_reason='identity_changed'
        FROM invalidated i WHERE o.id=i.occurrence_id AND o.user_id=$1 AND o.status='pending'`,
      [user.id, !hasOnboarded(s), s.consent_at, s.timezone_confirmed_at],
    );
    return {
      nextStage: transition.disposition === 'ready' ? 'action' : null,
      disposition: transition.disposition,
    };
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
