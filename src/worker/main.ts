import { setTimeout } from 'node:timers/promises';
import { readConfig } from '../config/env.js';
import { createPool } from '../db/pool.js';
import { IdentityProcessor } from '../modules/identity/store.js';

// Local onboarding only; model and delivery tasks remain durable and unconsumed.
const config = readConfig();
if (config.NODE_ENV === 'production')
  throw new Error('Local onboarding notice must be replaced before production use');
const pool = createPool(config.DATABASE_URL);
const identity = new IdentityProcessor(pool);
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
console.log(
  JSON.stringify({ event: 'worker_started', onboardingEnabled: true, modelEnabled: false }),
);
try {
  while (!stopping) {
    try {
      for (let i = 0; i < 50 && !stopping; i++) {
        const processed = await identity.processNext();
        if (!processed) break;
        console.log(JSON.stringify({ event: 'onboarding_processed', ...processed }));
      }
      const result = await pool.query(
        "SELECT count(*)::int AS pending FROM work_outbox WHERE status <> 'completed'",
      );
      console.log(
        JSON.stringify({
          event: 'work_backlog',
          pending: result.rows[0].pending,
          modelEnabled: false,
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
