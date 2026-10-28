import type { Pool, PoolClient } from 'pg';

export type WorkStage = 'onboarding' | 'action' | 'receipt';
export interface WorkLease {
  id: string;
  event_id: string;
  stage: WorkStage;
  lease_token: string;
  lease_owner: string;
  lease_until: Date;
  attempts: number;
  max_attempts: number;
}
export type WorkTransition = { nextStage: 'action' | null };
export class LeaseLostError extends Error {
  constructor() {
    super('Work lease expired or changed owner');
  }
}

export function retryDelay(attempt: number, random = Math.random): number {
  return Math.floor(
    Math.min(300000, 1000 * 2 ** Math.min(Math.max(attempt - 1, 0), 10)) * (0.5 + random() / 2),
  );
}

export class WorkQueue {
  constructor(private readonly pool: Pool) {}

  async claim(stage: WorkStage, owner: string, leaseMs = 30000): Promise<WorkLease | null> {
    if (
      !['onboarding', 'action', 'receipt'].includes(stage) ||
      !owner ||
      owner.length > 100 ||
      !Number.isInteger(leaseMs) ||
      leaseMs < 300 ||
      leaseMs > 300000
    )
      throw new Error('Invalid lease parameters');
    const result = await this.pool.query(
      `WITH candidate AS (
      SELECT q.id FROM work_outbox q JOIN ingress_events e ON e.id=q.event_id
      WHERE q.stage=$1 AND q.status='pending' AND q.available_at<=clock_timestamp() AND q.attempts<q.max_attempts
        AND NOT EXISTS (
          SELECT 1 FROM work_outbox prev JOIN ingress_events pe ON pe.id=prev.event_id
          WHERE pe.phone_number_id=e.phone_number_id AND pe.kind=e.kind
            AND COALESCE(pe.sender_id,pe.provider_message_id)=COALESCE(e.sender_id,e.provider_message_id)
            AND pe.sequence_no<e.sequence_no AND prev.status<>'completed'
            AND (prev.stage=q.stage OR (q.stage='action' AND prev.stage='onboarding'))
        )
      ORDER BY e.sequence_no LIMIT 1 FOR UPDATE OF q SKIP LOCKED
    ) UPDATE work_outbox q SET status='leased',lease_token=gen_random_uuid(),lease_owner=$2,
      lease_until=clock_timestamp()+$3::double precision*interval '1 millisecond',attempts=attempts+1
      FROM candidate c WHERE q.id=c.id RETURNING q.*`,
      [stage, owner, leaseMs],
    );
    return result.rows[0] ?? null;
  }

  async renew(lease: WorkLease, leaseMs: number): Promise<boolean> {
    if (!Number.isInteger(leaseMs) || leaseMs < 300 || leaseMs > 300000)
      throw new Error('Invalid lease duration');
    const result = await this.pool.query(
      `UPDATE work_outbox SET lease_until=clock_timestamp()+$3::double precision*interval '1 millisecond'
      WHERE id=$1 AND lease_token=$2 AND status='leased' AND lease_until>clock_timestamp() RETURNING id`,
      [lease.id, lease.lease_token, leaseMs],
    );
    return result.rowCount === 1;
  }

  /** Only short database effects belong here. External/slow work happens before this transaction. */
  async commit(
    lease: WorkLease,
    apply: (client: PoolClient) => Promise<WorkTransition>,
  ): Promise<void> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      const held = await client.query(
        `SELECT id FROM work_outbox WHERE id=$1 AND lease_token=$2
        AND status='leased' AND lease_until>clock_timestamp() FOR UPDATE`,
        [lease.id, lease.lease_token],
      );
      if (!held.rowCount) throw new LeaseLostError();
      const transition = await apply(client);
      if (
        transition.nextStage !== null &&
        !(lease.stage === 'onboarding' && transition.nextStage === 'action')
      ) {
        throw new Error('Unsupported work stage transition');
      }
      const final = await client.query(
        `UPDATE work_outbox SET status=$3,stage=COALESCE($4,stage),
        attempts=CASE WHEN $4::text IS NULL THEN attempts ELSE 0 END,
        available_at=clock_timestamp(),completed_at=CASE WHEN $4::text IS NULL THEN clock_timestamp() ELSE NULL END,
        lease_token=NULL,lease_until=NULL,lease_owner=NULL,last_error_code=NULL
        WHERE id=$1 AND lease_token=$2 AND status='leased' AND lease_until>clock_timestamp() RETURNING id`,
        [
          lease.id,
          lease.lease_token,
          transition.nextStage ? 'pending' : 'completed',
          transition.nextStage,
        ],
      );
      if (!final.rowCount) throw new LeaseLostError();
      if (transition.nextStage === null)
        await client.query('UPDATE ingress_events SET processed_at=clock_timestamp() WHERE id=$1', [
          lease.event_id,
        ]);
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
  }

  async fail(
    lease: WorkLease,
    code: 'handler_failed' | 'permanent_failure' | 'shutdown',
    delayMs = retryDelay(lease.attempts),
  ): Promise<boolean> {
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 300000)
      throw new Error('Invalid retry delay');
    const result = await this.pool.query(
      `UPDATE work_outbox SET
      status=CASE WHEN $3='permanent_failure' OR attempts>=max_attempts THEN 'dead' ELSE 'pending' END,
      last_error_code=$3,available_at=clock_timestamp()+$4::double precision*interval '1 millisecond',
      lease_until=NULL,lease_token=NULL,lease_owner=NULL
      WHERE id=$1 AND lease_token=$2 AND status='leased' AND lease_until>clock_timestamp() RETURNING id`,
      [lease.id, lease.lease_token, code, delayMs],
    );
    return result.rowCount === 1;
  }

  async recoverExpired(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Invalid recovery limit');
    const result = await this.pool.query(
      `WITH expired AS (
      SELECT id FROM work_outbox WHERE status='leased' AND lease_until<=clock_timestamp()
      ORDER BY lease_until LIMIT $1 FOR UPDATE SKIP LOCKED
    ), recovered AS (
      UPDATE work_outbox q SET status=CASE WHEN attempts>=max_attempts THEN 'dead' ELSE 'pending' END,
        available_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,lease_owner=NULL,
        last_error_code=CASE WHEN attempts>=max_attempts THEN 'attempts_exhausted' ELSE 'lease_expired' END
      FROM expired e WHERE q.id=e.id RETURNING q.id,q.status
    ) INSERT INTO work_recovery_events(work_id,action,actor)
      SELECT id,CASE WHEN status='dead' THEN 'attempts_exhausted' ELSE 'expired_retry' END,'lease_recovery'
      FROM recovered RETURNING id`,
      [limit],
    );
    return result.rowCount ?? 0;
  }

  async requeueDead(id: string, actor: string): Promise<boolean> {
    if (!actor || actor.length > 100) throw new Error('Operator identity required');
    const result = await this.pool.query(
      `WITH retried AS (
      UPDATE work_outbox SET status='pending',attempts=0,available_at=clock_timestamp(),last_error_code=NULL
      WHERE id=$1 AND status='dead' RETURNING id
    ) INSERT INTO work_recovery_events(work_id,action,actor)
      SELECT id,'operator_retry',$2 FROM retried RETURNING id`,
      [id, actor],
    );
    return result.rowCount === 1;
  }
}
