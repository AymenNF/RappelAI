import type { Pool } from 'pg';
import { z } from 'zod';
import { assertUsageOperator } from '../usage/control.js';

const minute = z.number().int().min(0).max(10000),
  day = z.number().int().min(0).max(1000000);
export const quotaPolicy = z
  .object({
    requests_minute: minute,
    requests_day: day,
    model_minute: minute,
    model_day: day,
    send_minute: minute,
    send_day: day,
    global_model_day: day,
    global_send_day: day,
    pending_reminders: z.number().int().min(0).max(100000),
    list_items: day,
  })
  .strict();
export class QuotaControl {
  constructor(private readonly pool: Pool) {}
  async status() {
    return (await this.pool.query('SELECT * FROM quota_policy WHERE singleton')).rows[0];
  }
  async change(input: unknown, note: string, userId?: string, blocked?: boolean) {
    if (!note.trim() || note.length > 500)
      throw new Error('Operator note required (1-500 characters)');
    const policy = userId ? null : quotaPolicy.parse(input);
    if (userId) {
      z.uuid().parse(userId);
      z.boolean().parse(blocked);
    }
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended(current_schema()||':privacy',0))",
      );
      await assertUsageOperator(c);
      if (userId) {
        if (!(await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId])).rowCount)
          throw new Error('Unknown account');
      }
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':quota-policy',0))",
      );
      const before = (await c.query('SELECT * FROM quota_policy WHERE singleton FOR UPDATE'))
        .rows[0];
      let previous: unknown = null;
      if (userId) {
        previous = (await c.query('SELECT blocked FROM quota_accounts WHERE user_id=$1', [userId]))
          .rows[0] ?? { blocked: false };
        await c.query(
          'INSERT INTO quota_accounts(user_id,blocked) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET blocked=EXCLUDED.blocked',
          [userId, blocked],
        );
      } else {
        const entries = Object.entries(policy!);
        await c.query(
          `UPDATE quota_policy SET ${entries.map(([k], i) => `${k}=$${i + 1}`).join(',')} WHERE singleton`,
          entries.map(([, v]) => v),
        );
      }
      await c.query('INSERT INTO quota_operator_audit(note,details) VALUES($1,$2)', [
        note,
        userId ? { userId, previous, blocked } : { before, after: policy },
      ]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
}
