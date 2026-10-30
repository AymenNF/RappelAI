import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { assertUsageOperator } from '../usage/control.js';
export const feedbackStatus = z.enum(['new', 'investigating', 'resolved']);
export const feedbackResolution = z.enum(['fixed', 'duplicate', 'expected', 'not_reproducible']);
export class BetaFeedbackControl {
  constructor(private pool: Pool) {}
  private async transaction<T>(fn: (c: PoolClient) => Promise<T>) {
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query('BEGIN');
      await assertUsageOperator(c);
      await c.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended(current_schema()||':privacy',0))",
      );
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await c.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw e;
    } finally {
      c.release(discard);
    }
  }
  list(status: unknown = 'new') {
    const state = feedbackStatus.parse(status);
    return this.transaction(
      async (c) =>
        (
          await c.query(
            'SELECT id,category,status,resolution,revision,created_at FROM beta_feedback WHERE status=$1 ORDER BY created_at,id LIMIT 100',
            [state],
          )
        ).rows,
    );
  }
  triage(id: string, revision: number, status: unknown, resolution: unknown = null) {
    z.uuid().parse(id);
    z.number().int().positive().parse(revision);
    const state = feedbackStatus.parse(status),
      reason = resolution === null ? null : feedbackResolution.parse(resolution);
    if ((state === 'resolved') !== (reason !== null))
      throw new Error('Resolution required only when resolved');
    return this.transaction(async (c) => {
      const r = await c.query(
        `UPDATE beta_feedback SET status=$3,resolution=$4,revision=revision+1,updated_at=clock_timestamp()
        WHERE id=$1 AND revision=$2 RETURNING user_id,revision`,
        [id, revision, state, reason],
      );
      if (!r.rowCount) throw new Error('Feedback missing or changed; reload before triage');
      await c.query(
        'INSERT INTO beta_feedback_audit(user_id,feedback_id,revision,status,resolution) VALUES($1,$2,$3,$4,$5)',
        [r.rows[0].user_id, id, r.rows[0].revision, state, reason],
      );
      return { id, revision: r.rows[0].revision, status: state, resolution: reason };
    });
  }
}
