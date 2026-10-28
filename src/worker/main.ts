import { setTimeout } from 'node:timers/promises';
import { readConfig } from '../config/env.js';
import { createPool } from '../db/pool.js';

// Foundation diagnostic only. Do not consume or acknowledge work before handlers exist.
const config = readConfig();
const pool = createPool(config.DATABASE_URL);
const controller = new AbortController();
let stopping = false;
pool.on('error', () =>
  console.error(JSON.stringify({ level: 'error', event: 'database_connection_failure' })),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopping = true;
    controller.abort();
  });
}
console.log(JSON.stringify({ event: 'worker_foundation_started', processingEnabled: false }));
try {
  while (!stopping) {
    try {
      const result = await pool.query(
        "SELECT count(*)::int AS pending FROM work_outbox WHERE status <> 'completed'",
      );
      console.log(
        JSON.stringify({
          event: 'work_backlog',
          pending: result.rows[0].pending,
          processingEnabled: false,
        }),
      );
    } catch {
      console.error(JSON.stringify({ level: 'error', event: 'backlog_query_failed' }));
    }
    try {
      await setTimeout(config.WORKER_POLL_INTERVAL_MS, undefined, { signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  }
} finally {
  await pool.end();
}
