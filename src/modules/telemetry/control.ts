import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { activeRules, rules, type AlertKey } from './rules.js';
import { collectSnapshot } from './snapshot.js';

export const queueKind = z.enum(['work', 'model', 'send', 'receipt', 'privacy']);
export type QueueKind = z.infer<typeof queueKind>;
export const queueCursor = z
  .object({ createdAt: z.iso.datetime({ offset: true }), id: z.uuid() })
  .strict();
const sources: Record<QueueKind, string> = {
  work: "SELECT id,created_at,stage||':'||status AS state FROM work_outbox WHERE status<>'completed'",
  model:
    "SELECT id,created_at,state FROM usage_reservations WHERE state IN ('reserved','dispatched','unknown')",
  send: `SELECT id,created_at,state||':'||recovery_state AS state FROM whatsapp_attempts a
    WHERE (state IN ('dispatching','unknown') AND recovery_state<>'abandoned')
      OR (state='rejected' AND recovery_state IN ('none','retry_wait','exhausted')) OR delivery_status='failed'
      OR EXISTS(SELECT 1 FROM delivery_recovery_audit conflict WHERE conflict.attempt_id=a.id AND conflict.action='late_acceptance_conflict'
        AND NOT EXISTS(SELECT 1 FROM delivery_recovery_audit r WHERE r.attempt_id=a.id AND r.action='operator_accepted' AND r.created_at>conflict.created_at))`,
  receipt:
    "SELECT event_id AS id,created_at,'unmatched' AS state FROM whatsapp_receipts WHERE attempt_id IS NULL",
  privacy:
    "SELECT id,deletion_requested_at AS created_at,'deletion_requested' AS state FROM users WHERE deletion_requested_at IS NOT NULL",
};
export class OperationsControl {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query('BEGIN');
      const access = (
        await c.query(
          "SELECT pg_has_role(current_user,'memorae_monitor','MEMBER') OR pg_has_role(current_user,relowner,'MEMBER') AS allowed FROM pg_class WHERE oid='usage_policy'::regclass",
        )
      ).rows[0];
      if (!access?.allowed)
        throw new Error('Operations controls require monitor or administrator access');
      // This aggregate statement has many small subqueries; avoid per-poll JIT compilation.
      await c.query('SET LOCAL jit=off');
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':monitoring',0))",
      );
      await c.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended(current_schema()||':privacy',0))",
      );
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await c.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      c.release(discard);
    }
  }
  async check() {
    return this.transaction(async (c) => {
      const snapshot = await collectSnapshot(c);
      const active = new Set(activeRules(snapshot.signals));
      const changes: {
        key: AlertKey;
        generation: number;
        transition: 'opened' | 'resolved';
        severity: string;
        action: string;
      }[] = [];
      for (const key of Object.keys(rules) as AlertKey[]) {
        const previous = (
          await c.query('SELECT * FROM monitoring_alerts WHERE key=$1 FOR UPDATE', [key])
        ).rows[0];
        let transition: 'opened' | 'resolved' | undefined;
        const generation =
          (previous?.generation ?? 0) + (active.has(key) && previous?.status !== 'active' ? 1 : 0);
        if (active.has(key)) {
          if (previous?.status !== 'active') transition = 'opened';
          await c.query(
            `INSERT INTO monitoring_alerts(key,generation,status,severity,affected,opened_at,observed_at)
            VALUES($1,$2,'active',$3,$4,$5,$5) ON CONFLICT(key) DO UPDATE SET
            generation=EXCLUDED.generation,status='active',severity=EXCLUDED.severity,affected=EXCLUDED.affected,
            opened_at=CASE WHEN monitoring_alerts.status='active' THEN monitoring_alerts.opened_at ELSE EXCLUDED.opened_at END,
            acknowledged_at=CASE WHEN monitoring_alerts.status='active' THEN monitoring_alerts.acknowledged_at ELSE NULL END,
            observed_at=EXCLUDED.observed_at,resolved_at=NULL`,
            [key, generation, rules[key].severity, snapshot.signals[key], snapshot.observedAt],
          );
        } else if (previous?.status === 'active') {
          transition = 'resolved';
          await c.query(
            "UPDATE monitoring_alerts SET status='resolved',affected=0,observed_at=$2,resolved_at=$2 WHERE key=$1",
            [key, snapshot.observedAt],
          );
        }
        if (transition) {
          await c.query(
            'INSERT INTO monitoring_events(key,generation,transition) VALUES($1,$2,$3)',
            [key, generation, transition],
          );
          changes.push({ key, generation, transition, ...rules[key] });
        }
      }
      await c.query(
        `INSERT INTO monitoring_snapshot(singleton,observed_at,data) VALUES(true,$1,$2)
        ON CONFLICT(singleton) DO UPDATE SET observed_at=EXCLUDED.observed_at,data=EXCLUDED.data`,
        [snapshot.observedAt, snapshot],
      );
      // Bounded pruning; current alert state survives history cleanup. No account records are touched.
      for (const [table, field, days] of [
        ['telemetry_batches', 'created_at', 7],
        ['telemetry_counters', 'minute', 7],
        ['monitoring_events', 'created_at', 30],
      ] as const)
        await c.query(
          `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${field}<clock_timestamp()-$1*interval '1 day' ORDER BY ${field} LIMIT 1000)`,
          [days],
        );
      return { snapshot, changes };
    });
  }
  async status() {
    return this.transaction(async (c) => ({
      observedAt: (await c.query('SELECT clock_timestamp() AS at')).rows[0].at,
      monitor: (
        await c.query(`SELECT CASE WHEN (SELECT observed_at FROM monitoring_snapshot) IS NULL THEN 'never_observed'
        WHEN (SELECT observed_at FROM monitoring_snapshot)<clock_timestamp()-interval '60 seconds' THEN 'stale' ELSE 'current' END AS state`)
      ).rows[0].state as string,
      policy: (await c.query('SELECT expect_api,expect_worker FROM monitoring_policy')).rows[0],
      latest: (await c.query('SELECT observed_at,data FROM monitoring_snapshot')).rows[0] ?? null,
      alerts: (await c.query('SELECT * FROM monitoring_alerts ORDER BY key')).rows.map((a) => ({
        ...a,
        action: rules[a.key as AlertKey].action,
      })),
      events: (
        await c.query(
          'SELECT sequence,key,generation,transition,created_at FROM monitoring_events ORDER BY sequence DESC LIMIT 50',
        )
      ).rows,
    }));
  }
  async expect(component: 'api' | 'worker', enabled: boolean) {
    z.enum(['api', 'worker']).parse(component);
    z.boolean().parse(enabled);
    await this.transaction(async (c) => {
      await c.query(`UPDATE monitoring_policy SET expect_${component}=$1 WHERE singleton`, [
        enabled,
      ]);
    });
  }
  async acknowledge(key: AlertKey, generation: number) {
    if (!Object.hasOwn(rules, key)) throw new Error('Unknown alert');
    z.number().int().positive().parse(generation);
    return this.transaction(async (c) => {
      const row = (
        await c.query(
          "SELECT * FROM monitoring_alerts WHERE key=$1 AND generation=$2 AND status='active' FOR UPDATE",
          [key, generation],
        )
      ).rows[0];
      if (!row) throw new Error('Alert generation is not active');
      if (row.acknowledged_at) return false;
      await c.query('UPDATE monitoring_alerts SET acknowledged_at=clock_timestamp() WHERE key=$1', [
        key,
      ]);
      await c.query(
        "INSERT INTO monitoring_events(key,generation,transition) VALUES($1,$2,'acknowledged')",
        [key, generation],
      );
      return true;
    });
  }
  async queue(kind: QueueKind, limit = 100, after?: z.infer<typeof queueCursor>) {
    queueKind.parse(kind);
    z.number().int().min(1).max(200).parse(limit);
    if (after) queueCursor.parse(after);
    return this.transaction(async (c) => {
      const rows = (
        await c.query(
          `SELECT id,state,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
        GREATEST(0,extract(epoch FROM clock_timestamp()-created_at))::float8 AS "ageSeconds"
        FROM (${sources[kind]}) q WHERE ($1::timestamptz IS NULL OR (created_at,id)>($1::timestamptz,$2::uuid))
        ORDER BY created_at,id LIMIT $3`,
          [after?.createdAt ?? null, after?.id ?? null, limit + 1],
        )
      ).rows;
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        kind,
        items,
        next:
          rows.length > limit
            ? { createdAt: last!.createdAt as string, id: last!.id as string }
            : null,
      };
    });
  }
}
