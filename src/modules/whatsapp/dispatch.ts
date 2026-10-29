import type { Pool } from 'pg';
import { z } from 'zod';
import { CONSENT_VERSION } from '../identity/onboarding.js';
import { boundedSend, textMessage, type WhatsAppTransport } from './send.js';
import { persistSendResult } from './attempts.js';

export const testSendPolicySchema = z
  .object({
    enabled: z.boolean(),
    phoneNumberId: z.string().regex(/^\d{1,30}$/),
    recipients: z
      .array(z.string().regex(/^\d{5,20}$/))
      .min(1)
      .max(5),
    timeoutMs: z.number().int().min(10).max(30000).default(10000),
  })
  .strict();
export type TestSendPolicy = z.input<typeof testSendPolicySchema>;
export class SendBlockedError extends Error {}

/** Test-only orchestration. Not wired to the live worker until Meta/consent qualification. */
export class TestReplySender {
  private readonly policy: z.output<typeof testSendPolicySchema>;
  constructor(
    private readonly pool: Pool,
    private readonly transport: WhatsAppTransport,
    policy: TestSendPolicy,
  ) {
    this.policy = testSendPolicySchema.parse(policy);
  }

  async send(eventId: string, signal?: AbortSignal): Promise<{ id: string; state: string }> {
    z.uuid().parse(eventId);
    if (!this.policy.enabled || signal?.aborted)
      throw new SendBlockedError('Test sending disabled');
    const client = await this.pool.connect();
    let attempt: { id: string; state: string };
    let message: z.infer<typeof textMessage>;
    try {
      await client.query('BEGIN');
      // Match the usage service lock order: policy before user. Pause fences later authorizations.
      const policy = (
        await client.query('SELECT enabled FROM usage_policy WHERE singleton FOR SHARE')
      ).rows[0];
      if (!policy?.enabled) throw new SendBlockedError('Global sending pause');
      const user = (
        await client.query(
          `SELECT u.* FROM users u JOIN identity_results i ON i.user_id=u.id
        WHERE i.event_id=$1 FOR UPDATE OF u`,
          [eventId],
        )
      ).rows[0];
      if (
        !user ||
        user.business_phone_id !== this.policy.phoneNumberId ||
        !this.policy.recipients.includes(user.sender_id)
      )
        throw new SendBlockedError('Outside test allowlist');
      const old = (
        await client.query('SELECT id,state FROM whatsapp_attempts WHERE event_id=$1', [eventId])
      ).rows[0];
      if (old) {
        await client.query('COMMIT');
        return old;
      }
      const source = (
        await client.query(
          `SELECT i.reply_text,i.disposition,i.consent_grant_at,i.timezone_confirmed_at,
        r.body,r.status,r.event_id AS reply_event_id,
        COALESCE(r.consent_grant_at,i.consent_grant_at) IS NOT DISTINCT FROM u.consent_at AS same_consent,
        COALESCE(r.timezone_confirmed_at,i.timezone_confirmed_at) IS NOT DISTINCT FROM u.timezone_confirmed_at AS same_zone,
        NOT EXISTS(SELECT 1 FROM identity_results newer JOIN ingress_events ne ON ne.id=newer.event_id
          WHERE newer.user_id=u.id AND ne.sequence_no>e.sequence_no) AS latest_identity,
        u.window_expires_at>clock_timestamp()+$2::double precision*interval '1 millisecond' AS open_window
        FROM identity_results i JOIN users u ON u.id=i.user_id JOIN ingress_events e ON e.id=i.event_id
        LEFT JOIN reply_intents r ON r.event_id=i.event_id WHERE i.event_id=$1`,
          [eventId, this.policy.timeoutMs + 1000],
        )
      ).rows[0];
      const planReply = !!source.reply_event_id;
      const body = planReply ? source.body : source.reply_text;
      if (!body) throw new SendBlockedError('No stored reply');
      const eligible =
        source.same_consent &&
        source.same_zone &&
        (planReply
          ? source.status === 'pending' &&
            !user.paused &&
            user.consent_version === CONSENT_VERSION &&
            !!user.consent_at &&
            !!user.timezone_confirmed_at &&
            !user.pending_timezone
          : source.latest_identity);
      const reason = !eligible ? 'identity_changed' : !source.open_window ? 'window_closed' : null;
      if (!reason && planReply) {
        const blocked = await client.query(
          `SELECT 1 FROM whatsapp_attempts WHERE user_id=$1
          AND state IN ('dispatching','unknown') LIMIT 1`,
          [user.id],
        );
        const earlier = await client.query(
          `SELECT 1 FROM reply_intents r JOIN ingress_events e ON e.id=r.event_id
          LEFT JOIN whatsapp_attempts a ON a.event_id=r.event_id
          WHERE r.user_id=$1 AND r.status='pending' AND a.id IS NULL
          AND e.sequence_no<(SELECT sequence_no FROM ingress_events WHERE id=$2) LIMIT 1`,
          [user.id, eventId],
        );
        if (blocked.rowCount || earlier.rowCount)
          throw new SendBlockedError('Earlier reply unresolved');
      }
      message = textMessage.parse({
        phoneNumberId: user.business_phone_id,
        recipientId: user.sender_id,
        body,
      });
      attempt = (
        await client.query(
          `INSERT INTO whatsapp_attempts(user_id,event_id,identity_event_id,reply_event_id,
        phone_number_id,recipient_id,state,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,state`,
          [
            user.id,
            eventId,
            planReply ? null : eventId,
            planReply ? eventId : null,
            user.business_phone_id,
            user.sender_id,
            reason ? 'suppressed' : 'dispatching',
            reason,
          ],
        )
      ).rows[0];
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (attempt.state === 'suppressed') return attempt;
    // Authorization is durable before I/O. Never resend a dispatching/unknown attempt, even after a crash.
    const result = await boundedSend(this.transport, message, this.policy.timeoutMs, signal);
    await persistSendResult(this.pool, attempt.id, result);
    return { id: attempt.id, state: result.state };
  }
}
