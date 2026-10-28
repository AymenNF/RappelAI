import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../config/env.js';
import { createPool } from '../db/pool.js';
import { assertRuntimeRole, runtimeDatabaseUrl } from '../db/runtime.js';
import { IdentityProcessor } from '../modules/identity/store.js';
import { WorkQueue } from '../modules/processing/leases.js';
import { WorkRunner } from '../modules/processing/runner.js';
import { ModelAdapter } from '../modules/processing/model.js';
import { PlanProcessor } from '../modules/processing/plans.js';
import { fixtureTransport } from '../modules/processing/fixture.js';

// Local onboarding and opt-in offline plan generation; no paid calls or execution.
const config = readConfig();
if (config.NODE_ENV === 'production')
  throw new Error('Local onboarding notice must be replaced before production use');
const pool = createPool(runtimeDatabaseUrl('worker'));
await assertRuntimeRole(pool, 'worker').catch(async (error: unknown) => {
  await pool.end();
  throw error;
});
const identity = new IdentityProcessor(pool);
const queue = new WorkQueue(pool);
const runner = new WorkRunner(queue, `worker-${randomUUID()}`);
const planner =
  config.MODEL_MODE === 'fixture'
    ? new PlanProcessor(pool, new ModelAdapter(fixtureTransport, config.MODEL_TIMEOUT_MS))
    : null;
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
  JSON.stringify({
    event: 'worker_started',
    onboardingEnabled: true,
    modelMode: config.MODEL_MODE,
    remoteModelEnabled: false,
  }),
);
try {
  while (!stopping) {
    try {
      const recovered = await queue.recoverExpired();
      if (recovered) console.log(JSON.stringify({ event: 'work_recovered', count: recovered }));
      for (let i = 0; i < 50 && !stopping; i++) {
        const processed = await runner.runOne(
          'onboarding',
          {
            prepare: async () => null,
            apply: (client, lease) => identity.apply(client, lease.event_id),
          },
          controller.signal,
        );
        if (!processed) break;
      }
      if (planner) {
        for (let i = 0; i < 50 && !stopping; i++) {
          if (!(await runner.runOne('action', planner, controller.signal))) break;
        }
      }
      const result = await pool.query(
        "SELECT stage,status,count(*)::int AS count FROM work_outbox WHERE status <> 'completed' GROUP BY stage,status",
      );
      console.log(
        JSON.stringify({
          event: 'work_backlog',
          counts: result.rows,
          modelMode: config.MODEL_MODE,
          remoteModelEnabled: false,
        }),
      );
    } catch {
      console.error(JSON.stringify({ level: 'error', event: 'work_cycle_failed' }));
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
