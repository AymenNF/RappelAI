import type { Pool } from 'pg';
import { z } from 'zod';
import { assertUsageOperator } from '../usage/control.js';

export class BackupControl {
  constructor(private readonly pool: Pool) {}
  async change(command: { enabled: boolean } | { abandon: string }) {
    if ('enabled' in command) z.boolean().parse(command.enabled);
    else z.uuid().parse(command.abandon);
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query('BEGIN');
      await assertUsageOperator(c);
      if ('enabled' in command) {
        await c.query('UPDATE backup_monitoring_policy SET enabled=$1 WHERE singleton', [
          command.enabled,
        ]);
        await c.query('INSERT INTO backup_policy_audit(enabled) VALUES($1)', [command.enabled]);
      } else {
        const result = await c.query(
          `UPDATE backup_runs SET state='failed',error_code='interrupted',finished_at=clock_timestamp()
          WHERE id=$1 AND state='running' AND started_at<=clock_timestamp()-(SELECT max_backup_duration_seconds FROM backup_monitoring_policy WHERE singleton)*interval '1 second'`,
          [command.abandon],
        );
        if (!result.rowCount) throw new Error('Only an overdue running backup can be abandoned');
      }
      await c.query('COMMIT');
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
}
