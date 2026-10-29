import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { assertUsageOperator } from '../usage/control.js';
import { cancelActivity } from './commands.js';

const addressEvents = `phone_number_id=$1 AND (sender_id=$2 OR (kind='delivery.status' AND payload->>'recipient_id'=$2))`;
export function sanitizeExport(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeExport);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            !/(^|_)(token|secret|password)$/.test(k) && !['reference', 'lease_owner'].includes(k),
        )
        .map(([k, v]) => [k, sanitizeExport(v)]),
    );
  return value;
}
export class PrivacyAdmin {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(
    operation: (c: PoolClient) => Promise<T>,
    mode: 'shared' | 'exclusive' = 'exclusive',
    snapshot = false,
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query(snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
      await assertUsageOperator(c);
      await c.query(
        `SELECT pg_advisory_xact_lock${mode === 'shared' ? '_shared' : ''}(hashtextextended(current_schema()||':privacy',0))`,
      );
      const result = await operation(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async status() {
    return this.transaction(
      async (c) => ({
        requests: (
          await c.query(
            "SELECT id,user_id,kind,status,created_at FROM privacy_requests WHERE status IN ('offered','requested') ORDER BY created_at LIMIT 100",
          )
        ).rows,
        retention: (await c.query('SELECT raw_days,counter_days FROM privacy_retention')).rows[0],
      }),
      'shared',
    );
  }
  async exportRequest(requestId: string) {
    z.uuid().parse(requestId);
    return this.transaction(
      async (c) => {
        const user = (
          await c.query(
            `SELECT u.* FROM users u JOIN privacy_requests r ON r.user_id=u.id
        WHERE r.id=$1 AND r.kind='export' AND r.status='requested' AND u.deletion_requested_at IS NULL FOR UPDATE OF u`,
            [requestId],
          )
        ).rows[0];
        if (!user) throw new Error('Export request unavailable');
        const tables = (
          await c.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='user_id' AND NOT a.attisdropped
        WHERE n.nspname=current_schema() AND c.relkind='r' ORDER BY c.relname`)
        ).rows;
        const data: Record<string, unknown> = { users: [user] };
        for (const { relname } of tables) {
          if (!/^[a-z0-9_]+$/.test(relname)) throw new Error('Unsupported export table');
          data[relname] = (
            await c.query(`SELECT * FROM ${relname} WHERE user_id=$1`, [user.id])
          ).rows;
        }
        data.ingress_events = (
          await c.query(
            `SELECT * FROM ingress_events WHERE ${addressEvents} ORDER BY sequence_no`,
            [user.business_phone_id, user.sender_id],
          )
        ).rows;
        data.work_outbox = (
          await c.query(
            `SELECT q.* FROM work_outbox q JOIN ingress_events e ON e.id=q.event_id
        WHERE e.phone_number_id=$1 AND (e.sender_id=$2 OR (e.kind='delivery.status' AND e.payload->>'recipient_id'=$2))`,
            [user.business_phone_id, user.sender_id],
          )
        ).rows;
        data.usage_audit = (
          await c.query(
            "SELECT a.* FROM usage_audit a LEFT JOIN usage_reservations r ON r.id=a.reservation_id WHERE r.user_id=$1 OR a.details->>'userId'=$1::text",
            [user.id],
          )
        ).rows;
        data.quota_operator_audit = (
          await c.query("SELECT * FROM quota_operator_audit WHERE details->>'userId'=$1", [user.id])
        ).rows;
        data.whatsapp_receipts = (
          await c.query(
            'SELECT * FROM whatsapp_receipts WHERE user_id=$1 OR (phone_number_id=$2 AND recipient_id=$3)',
            [user.id, user.business_phone_id, user.sender_id],
          )
        ).rows;
        data.work_recovery_events = (
          await c.query(
            `SELECT a.* FROM work_recovery_events a JOIN work_outbox q ON q.id=a.work_id JOIN ingress_events e ON e.id=q.event_id
        WHERE e.phone_number_id=$1 AND (e.sender_id=$2 OR (e.kind='delivery.status' AND e.payload->>'recipient_id'=$2))`,
            [user.business_phone_id, user.sender_id],
          )
        ).rows;
        return sanitizeExport({
          format: 'memorae-export-v1',
          generatedAt: (await c.query('SELECT clock_timestamp() AS now')).rows[0].now,
          requestId,
          notes: [
            'Dedicated credential/control-token fields omitted; historical messages may still contain confirmation strings. Redacted raw messages cannot be reconstructed. This local file is a separate copy requiring its own secure delivery and cleanup.',
          ],
          data,
        });
      },
      'shared',
      true,
    );
  }
  async markExported(requestId: string) {
    z.uuid().parse(requestId);
    await this.transaction(async (c) => {
      const r = await c.query(
        "UPDATE privacy_requests SET status='exported' WHERE id=$1 AND kind='export' AND status='requested' RETURNING id",
        [requestId],
      );
      if (!r.rowCount) throw new Error('Export request unavailable');
      await c.query(
        "INSERT INTO privacy_operations(action,counts) VALUES('exported','{\"files\":1}')",
      );
    });
  }
  /** Explicit operator command: drain work first, then erase only after all external outcomes settle. */
  async purge(
    userId: string,
  ): Promise<{ status: 'held' | 'purged' | 'absent'; workCancelled: number }> {
    z.uuid().parse(userId);
    return this.transaction(async (c) => {
      // Usage serialization precedes work/user locks, matching dispatch. Worker commits share privacy lock.
      await c.query('SELECT singleton FROM usage_policy FOR UPDATE');
      const lookup = (
        await c.query(
          'SELECT business_phone_id,sender_id,deletion_requested_at FROM users WHERE id=$1',
          [userId],
        )
      ).rows[0];
      if (!lookup) return { status: 'absent', workCancelled: 0 };
      if (!lookup.deletion_requested_at) throw new Error('Confirmed account deletion required');
      const params = [lookup.business_phone_id, lookup.sender_id];
      const work = await c.query(
        `UPDATE work_outbox q SET status='completed',completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,lease_owner=NULL,last_error_code='account_deletion'
        FROM ingress_events e WHERE e.id=q.event_id AND e.phone_number_id=$1 AND e.sender_id=$2 AND q.status<>'completed' RETURNING q.id`,
        params,
      );
      await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      await cancelActivity(c, userId);
      const held = (
        await c.query(
          `SELECT EXISTS(SELECT 1 FROM usage_reservations WHERE user_id=$1 AND state IN ('reserved','dispatched','unknown'))
        OR EXISTS(SELECT 1 FROM whatsapp_attempts WHERE user_id=$1 AND (state='dispatching' OR (state='unknown' AND recovery_state<>'abandoned'))) AS held`,
          [userId],
        )
      ).rows[0].held;
      if (held) return { status: 'held', workCancelled: work.rowCount ?? 0 };
      await c.query('SET CONSTRAINTS ALL DEFERRED');
      await c.query(
        `INSERT INTO privacy_tombstones(fingerprint)
        SELECT encode(sha256(convert_to(secret||jsonb_build_array($1::text,$2::text)::text,'UTF8')),'hex') FROM privacy_key ON CONFLICT DO NOTHING`,
        params,
      );
      // Include unmatched/early receipts for this exact address, without touching another recipient.
      await c.query(
        'DELETE FROM whatsapp_receipts WHERE phone_number_id=$1 AND recipient_id=$2',
        params,
      );
      await c.query("DELETE FROM quota_operator_audit WHERE details->>'userId'=$1", [userId]);
      await c.query("DELETE FROM usage_audit WHERE details->>'userId'=$1", [userId]);
      await c.query('DELETE FROM users WHERE id=$1', [userId]);
      const events = await c.query(`DELETE FROM ingress_events WHERE ${addressEvents}`, params);
      await c.query("INSERT INTO privacy_operations(action,counts) VALUES('purged',$1)", [
        { accounts: 1, events: events.rowCount ?? 0 },
      ]);
      return { status: 'purged', workCancelled: work.rowCount ?? 0 };
    });
  }
  /** Bounded maintenance. Never redacts unfinished work or material needed for unresolved operations. */
  async retain(limit = 100, apply = false) {
    z.number().int().min(1).max(1000).parse(limit);
    return this.transaction(async (c) => {
      if (!apply) await c.query('SAVEPOINT retention_preview');
      const policy = (await c.query('SELECT * FROM privacy_retention WHERE singleton')).rows[0];
      const raw = await c.query(
        `WITH candidates AS (
        SELECT e.id FROM ingress_events e JOIN work_outbox q ON q.event_id=e.id
        WHERE e.redacted_at IS NULL AND e.received_at<clock_timestamp()-$1*interval '1 day' AND q.status='completed'
        AND NOT EXISTS(SELECT 1 FROM usage_reservations r WHERE r.event_id=e.id AND r.state IN ('reserved','dispatched','unknown'))
        AND NOT EXISTS(SELECT 1 FROM whatsapp_attempts a WHERE (a.event_id=e.id OR (a.phone_number_id=e.phone_number_id AND a.provider_message_id=e.provider_message_id))
          AND (a.state IN ('dispatching','unknown') OR a.recovery_state='retry_wait'))
        ORDER BY e.received_at,e.id LIMIT $2 FOR UPDATE OF e
      ) UPDATE ingress_events e SET payload=jsonb_build_object('redacted',true,'recipient_id',e.payload->>'recipient_id'),redacted_at=clock_timestamp()
        FROM candidates x WHERE e.id=x.id RETURNING e.id`,
        [policy.raw_days, limit],
      );
      const counters = await c.query(
        `WITH old AS(SELECT user_id,metric,period FROM quota_counters
        WHERE period<clock_timestamp()-$1*interval '1 day' ORDER BY period LIMIT $2)
        DELETE FROM quota_counters c USING old WHERE c.user_id=old.user_id AND c.metric=old.metric AND c.period=old.period RETURNING c.user_id`,
        [policy.counter_days, limit],
      );
      const global = await c.query(
        `WITH old AS(SELECT metric,period FROM quota_global_counters
        WHERE period<clock_timestamp()-$1*interval '1 day' ORDER BY period LIMIT $2)
        DELETE FROM quota_global_counters c USING old WHERE c.metric=old.metric AND c.period=old.period RETURNING c.metric`,
        [policy.counter_days, limit],
      );
      const offers = await c.query(
        `WITH old AS(SELECT id FROM privacy_requests WHERE status='offered' AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT $1)
        UPDATE privacy_requests r SET status='expired' FROM old WHERE r.id=old.id RETURNING r.id`,
        [limit],
      );
      const result = {
        rawRedacted: raw.rowCount ?? 0,
        userCountersDeleted: counters.rowCount ?? 0,
        globalCountersDeleted: global.rowCount ?? 0,
        offersExpired: offers.rowCount ?? 0,
      };
      if (!apply) await c.query('ROLLBACK TO SAVEPOINT retention_preview');
      else if (Object.values(result).some(Boolean))
        await c.query("INSERT INTO privacy_operations(action,counts) VALUES('retention',$1)", [
          result,
        ]);
      return result;
    });
  }
}
