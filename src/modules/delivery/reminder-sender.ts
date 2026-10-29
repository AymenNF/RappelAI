import { consumeQuota } from '../quotas/service.js';
import type { Pool } from 'pg';
import { z } from 'zod';
import { hasOnboarded, type IdentityState } from '../identity/onboarding.js';
import {
  SendBlockedError,
  testSendPolicySchema,
  type TestSendPolicy,
} from '../whatsapp/dispatch.js';
import {
  boundedSend,
  whatsappMessage,
  type WhatsAppMessage,
  type WhatsAppTransport,
} from '../whatsapp/send.js';
import { persistSendResult } from '../whatsapp/attempts.js';
import { latestAttempt, expireRetry, auditDelivery } from '../whatsapp/retry.js';
import { ensureReminderControl, controlButtons } from '../reminders/controls.js';

/** Injectable test-number delivery path. No production runtime or billable-send authorization. */
export class ReminderSender {
  private readonly policy: z.output<typeof testSendPolicySchema>;
  constructor(
    private readonly pool: Pool,
    private readonly transport: WhatsAppTransport,
    policy: TestSendPolicy,
  ) {
    this.policy = testSendPolicySchema.parse(policy);
  }

  async send(outboundId: string, signal?: AbortSignal): Promise<{ id: string; state: string }> {
    z.uuid().parse(outboundId);
    if (!this.policy.enabled || signal?.aborted)
      throw new SendBlockedError('Test sending disabled');
    const client = await this.pool.connect();
    let discard = false;
    let attempt: { id: string; state: string };
    let message: WhatsAppMessage | undefined;
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended(current_schema()||':privacy',0))",
      );
      // Same lock ordering as metered planning and onboarding. No lock survives network I/O.
      const policy = (
        await client.query('SELECT enabled FROM usage_policy WHERE singleton FOR SHARE')
      ).rows[0];
      if (!policy?.enabled) throw new SendBlockedError('Global sending pause');
      const user = (
        await client.query(
          `SELECT u.* FROM users u JOIN outbound_messages m ON m.user_id=u.id
        WHERE m.id=$1 FOR UPDATE OF u`,
          [outboundId],
        )
      ).rows[0];
      if (
        !user ||
        user.business_phone_id !== this.policy.phoneNumberId ||
        !this.policy.recipients.includes(user.sender_id)
      )
        throw new SendBlockedError('Outside test allowlist');
      const old = await latestAttempt(client, 'outbound_message_id', outboundId);
      if (old) {
        if (old.recovery_state === 'retry_wait' && old.retry_expired)
          await expireRetry(client, old);
        else if (old.recovery_state === 'retry_wait' && !old.retry_due)
          throw new SendBlockedError('Delivery retry not due');
        if (old.recovery_state !== 'retry_wait' || old.retry_expired) {
          await client.query('COMMIT');
          return { id: old.id, state: old.state };
        }
      }
      // Lock the lifecycle row too: cancellation/version changes must serialize with authorization.
      const source = (
        await client.query(
          `SELECT m.*,o.reminder_id,o.status AS occurrence_status,
        r.status AS reminder_status,
        (o.schedule_version=r.schedule_version AND o.original_due_at=r.due_at) AS current_schedule,
        (m.consent_grant_at=u.consent_at AND m.timezone_confirmed_at=u.timezone_confirmed_at
          AND m.timezone=u.timezone) AS current_identity
        FROM outbound_messages m JOIN users u ON u.id=m.user_id
        JOIN reminder_occurrences o ON o.id=m.occurrence_id AND o.user_id=m.user_id
        JOIN reminders r ON r.id=o.reminder_id AND r.user_id=o.user_id
        WHERE m.id=$1 FOR UPDATE OF r,o,m`,
          [outboundId],
        )
      ).rows[0];
      const reason =
        !hasOnboarded(user as IdentityState) ||
        !source.current_identity ||
        source.status !== 'pending' ||
        source.occurrence_status !== 'pending'
          ? 'identity_changed'
          : source.reminder_status !== 'pending' || !source.current_schedule
            ? 'stale_reminder'
            : null;
      let templateId: string | null = null;
      if (!reason) {
        const earlier = await client.query(
          `SELECT 1 FROM outbound_messages m
          LEFT JOIN LATERAL (SELECT * FROM whatsapp_attempts WHERE outbound_message_id=m.id ORDER BY attempt_no DESC LIMIT 1) a ON true
          WHERE m.user_id=$1 AND m.status='pending' AND (a.id IS NULL OR a.recovery_state='retry_wait')
          AND (m.available_at,m.id)<(SELECT available_at,id FROM outbound_messages WHERE id=$2) LIMIT 1`,
          [user.id, outboundId],
        );
        const unknown = await client.query(
          "SELECT 1 FROM whatsapp_attempts WHERE user_id=$1 AND state IN ('dispatching','unknown') AND recovery_state<>'abandoned' LIMIT 1",
          [user.id],
        );
        if (earlier.rowCount || unknown.rowCount)
          throw new SendBlockedError('Earlier delivery unresolved');
        const preference =
          (
            await client.query('SELECT reply_language FROM user_preferences WHERE user_id=$1', [
              user.id,
            ])
          ).rows[0]?.reply_language ?? 'en';
        // Shared with the deployment-owned template mutation trigger; no runtime approval grant.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('whatsapp-template:'||$1,0))",
          [user.business_phone_id],
        );
        // Read the newest version even if paused/rejected. Never fall back to an older approval.
        const template = (
          await client.query(
            `SELECT * FROM whatsapp_templates WHERE phone_number_id=$1 AND reply_language=$2
          ORDER BY version DESC LIMIT 1`,
            [user.business_phone_id, preference],
          )
        ).rows[0];
        // Recheck the window on the database clock AFTER all potentially waiting locks.
        const timing = (
          await client.query(
            `SELECT
          m.available_at<=clock_timestamp() AS due,
          u.window_expires_at>clock_timestamp()+$2::double precision*interval '1 millisecond' AS open_window,
          ($3::timestamptz<=clock_timestamp() AND $4::timestamptz>clock_timestamp()+$2::double precision*interval '1 millisecond') AS verified_template
          FROM users u JOIN outbound_messages m ON m.user_id=u.id WHERE m.id=$1`,
            [
              outboundId,
              this.policy.timeoutMs + 1000,
              template?.verified_at ?? null,
              template?.valid_until ?? null,
            ],
          )
        ).rows[0];
        if (!timing.due) throw new SendBlockedError('Reminder not due');
        const address = {
          phoneNumberId: user.business_phone_id as string,
          recipientId: user.sender_id as string,
        };
        if (timing.open_window)
          message = {
            ...address,
            body: source.body as string,
            buttons: controlButtons(
              await ensureReminderControl(client, user.id, source.reminder_id),
            ),
          };
        else {
          if (!template || template.approval_status !== 'approved' || !timing.verified_template)
            throw new SendBlockedError('Approved template unavailable');
          // The one parameter is the immutable outbound body, never a newly generated model reply.
          if (template.body_format.replace('{{1}}', () => source.body).length > 1024)
            throw new SendBlockedError('Template content exceeds supported length');
          message = {
            ...address,
            template: {
              name: template.name,
              languageCode: template.language_code,
              bodyParameter: source.body,
            },
          };
          templateId = template.id;
        }
        const parsed = whatsappMessage.safeParse(message);
        if (!parsed.success) throw new SendBlockedError('Message does not fit supported format');
        message = parsed.data;
      }
      if (signal?.aborted) throw new SendBlockedError('Dispatch cancelled');
      if (!reason) {
        const denied = await consumeQuota(client, user.id, 'send');
        if (denied) throw new SendBlockedError(`Send quota: ${denied}; see QUOTA for limits`);
      }
      attempt = (
        await client.query(
          `INSERT INTO whatsapp_attempts(user_id,outbound_message_id,phone_number_id,recipient_id,
        state,error_code,template_id,message_payload,attempt_no,previous_attempt_id,retry_until,dispatch_deadline)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz,clock_timestamp()+interval '1 day'),clock_timestamp()+$12*interval '1 millisecond') RETURNING id,state`,
          [
            user.id,
            outboundId,
            user.business_phone_id,
            user.sender_id,
            reason ? 'suppressed' : 'dispatching',
            reason,
            templateId,
            message ?? null,
            (old?.attempt_no ?? 0) + 1,
            old?.id ?? null,
            old?.retry_until ?? null,
            this.policy.timeoutMs + 30000,
          ],
        )
      ).rows[0];
      await auditDelivery(
        client,
        { ...attempt, user_id: user.id },
        old ? 'retry_authorized' : 'authorized',
      );
      await client.query('COMMIT');
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
    if (attempt.state === 'suppressed') return attempt;
    const result = await boundedSend(this.transport, message!, this.policy.timeoutMs, signal);
    await persistSendResult(this.pool, attempt.id, result);
    return { id: attempt.id, state: result.state };
  }

  /** Bounded queue pass; blocked users do not prevent other recipients from progressing. */
  async sendPending(
    limit = 50,
    signal?: AbortSignal,
  ): Promise<{ examined: number; attempted: number; blocked: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Delivery limit must be an integer from 1 to 100');
    const result = { examined: 0, attempted: 0, blocked: 0 };
    if (signal?.aborted || !this.policy.enabled) return result;
    // One oldest intent per user per pass, so a blocked backlog cannot starve another user.
    const pending = await this.pool.query(
      `SELECT candidates.id FROM users u
      CROSS JOIN LATERAL (SELECT m.id,m.available_at FROM outbound_messages m
        LEFT JOIN LATERAL (SELECT * FROM whatsapp_attempts WHERE outbound_message_id=m.id ORDER BY attempt_no DESC LIMIT 1) a ON true
        WHERE m.user_id=u.id AND m.status='pending' AND m.available_at<=clock_timestamp()
        AND (a.id IS NULL OR a.recovery_state='retry_wait')
        ORDER BY m.available_at,m.id LIMIT 1) candidates
      WHERE u.business_phone_id=$1 AND u.sender_id=ANY($2::text[])
      ORDER BY candidates.available_at,candidates.id LIMIT $3`,
      [this.policy.phoneNumberId, this.policy.recipients, limit],
    );
    for (const row of pending.rows) {
      if (signal?.aborted) break;
      result.examined++;
      try {
        await this.send(row.id, signal);
        result.attempted++;
      } catch (error) {
        if (!(error instanceof SendBlockedError)) throw error;
        result.blocked++;
      }
    }
    return result;
  }
}
