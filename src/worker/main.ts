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
import { UsageService } from '../modules/usage/service.js';
import { ExecutionProcessor } from '../modules/processing/execution.js';
import { ReceiptProcessor } from '../modules/whatsapp/receipts.js';
import { ReminderScheduler } from '../modules/reminders/scheduler.js';
import { DeliveryRecovery } from '../modules/whatsapp/recovery.js';

// Local onboarding, optional offline planning and transactional execution; no provider sends.
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
const usage = new UsageService(pool);
const execution = new ExecutionProcessor();
const receipts = new ReceiptProcessor();
const scheduler = new ReminderScheduler(pool);
const deliveryRecovery = new DeliveryRecovery(pool);
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
    executionEnabled: true,
    receiptHandlingEnabled: true,
    deliveryRecoveryEnabled: true,
    reminderSchedulingEnabled: true,
    whatsappSendingEnabled: false,
  }),
);
try {
  while (!stopping) {
    try {
      const recovered = await queue.recoverExpired();
      const deliveriesRecovered = await deliveryRecovery.recover();
      if (deliveriesRecovered)
        console.log(JSON.stringify({ event: 'delivery_recovered', count: deliveriesRecovered }));
      const usageRecovered = await usage.recover();
      if (usageRecovered)
        console.log(JSON.stringify({ event: 'usage_recovered', count: usageRecovered }));
      if (recovered) console.log(JSON.stringify({ event: 'work_recovered', count: recovered }));
      for (let i = 0; i < 50 && !stopping; i++) {
        if (!(await runner.runOne('receipt', receipts, controller.signal))) break;
      }
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
      for (let i = 0; i < 50 && !stopping; i++) {
        const planned = planner ? await runner.runOne('action', planner, controller.signal) : false;
        const executed = await runner.runOne('execution', execution, controller.signal);
        if (!planned && !executed) break;
      }
      if (!stopping) {
        const scheduled = await scheduler.sweep(100, controller.signal);
        if (scheduled.examined)
          console.log(JSON.stringify({ event: 'reminders_scheduled', ...scheduled }));
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
